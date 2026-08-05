import { safeFetch } from "./hosts";
import { queuedFetch } from "./httpQueue";
import { logger } from "./logger";

// 国内网络下 mempool.space / blockstream.info 常被限速到不可用，
// blockchain.info 国内通常可访问，作为主路径。
// 它的 API 格式与 mempool 不同（/unspent、/rawaddr、/multiaddr 而非 /address/*/utxo），
// 这里适配成 mempool 兼容的结构，让上游解析逻辑（parseUtxoResponse / fetchAddressState）不改。

const BASE = "https://lumis.tpr.wales/btc";

// ───────────────────────────────────────────────────────────────────────────
// 【批量查询】blockchain.info 的 active 参数接受 `|` 分隔的多地址。
//
// 旧实现是「一个地址一次请求」：gap limit 20 → receive+change 共 42 个地址 →
// 一次余额刷新 42 次 HTTP。第三方公共 API 对单 IP 不宽容，其中若干次必被限流，
// fanout 如实报告 complete=false，但上层（useVault / getWalletUtxosCached）为了
// 「能用」又容忍了部分失败 —— 结果就是**每次刷新失败的地址不同，余额随之跳变**。
// 这正是「金库余额显示不稳定」的直接成因。
//
// 改成批量后 42 个地址 = 2~3 次请求，限流概率几乎归零，complete 稳定为 true。
//
// 每批地址数：bech32 地址 62 字符 + 分隔符，20 个约 1.3 KB URL，
// 远低于常见反代 2 KB 的 URL 上限，同时把请求数压到个位数。
// ───────────────────────────────────────────────────────────────────────────
const ADDRESSES_PER_BATCH = 20;

/** blockchain.info /unspent 的默认 limit 是 250，多地址批量下必须显式提高。 */
const UNSPENT_LIMIT = 1000;

export function chunkAddresses(addresses: readonly string[], size = ADDRESSES_PER_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < addresses.length; i += size) {
    out.push(addresses.slice(i, i + size) as string[]);
  }
  return out;
}

type MempoolUtxoRaw = {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean };
  /** 批量查询时用于把 UTXO 归属回具体地址；单地址查询下为 undefined。 */
  scriptHex?: string;
};

type BciUnspentOutput = {
  tx_hash?: string;
  tx_hash_big_endian?: string;
  tx_output_n?: number;
  value?: number;
  confirmations?: number;
  script?: string;
};

/**
 * blockchain.info 的 `tx_hash` 是**内部字节序**（与区块链浏览器上显示的 txid 逆序）。
 * 显示序在 `tx_hash_big_endian` 字段。
 *
 * 【这是热钱包发币失败的根因】旧实现直接取 `tx_hash`，于是 PSBT 的每个 input 都
 * 指向一个**不存在的 outpoint**。本地签名不触网、witnessUtxo.script 又是自己算的，
 * 所有校验都过；直到广播时全节点才以 `bad-txns-inputs-missingorspent` 拒绝 ——
 * 表现就是「构造、签名、确认都正常，最后一步 400 失败」。
 */
function normalizeTxid(o: BciUnspentOutput): string | null {
  const big = o.tx_hash_big_endian;
  if (typeof big === "string" && /^[0-9a-fA-F]{64}$/.test(big)) return big.toLowerCase();
  const raw = o.tx_hash;
  if (typeof raw !== "string" || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  // 没有 big_endian 字段时自行逆序（每 2 个 hex 字符为 1 字节）。
  const bytes = raw.toLowerCase().match(/../g);
  if (!bytes) return null;
  return bytes.reverse().join("");
}

function mapUnspentOutputs(list: BciUnspentOutput[]): MempoolUtxoRaw[] {
  const out: MempoolUtxoRaw[] = [];
  for (const o of list) {
    const txid = normalizeTxid(o);
    if (!txid) continue;
    const vout = Number(o.tx_output_n);
    const value = Number(o.value);
    if (!Number.isInteger(vout) || vout < 0) continue;
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      txid,
      vout,
      value,
      // confirmations 字段缺失时按「已确认」处理（保守：不会凭空多出可花余额）。
      status: { confirmed: (o.confirmations ?? 1) > 0 },
      scriptHex: typeof o.script === "string" ? o.script.toLowerCase() : undefined,
    });
  }
  return out;
}

/**
 * blockchain.info 用 HTTP 500 表达「这些地址没有可花费输出」，**同时** 500 也是
 * 它真出故障 / 被限流时的状态码。必须靠响应体区分。
 */
const NO_FREE_OUTPUTS = /no\s+free\s+outputs/i;

/**
 * `active=a|b|c` 里的 `|` **必须百分号编码**。
 * 它不是合法 URL 字符：iOS 的 NSURLSession 对非法字符直接返回 nil（fetch 立刻失败），
 * Android 的 OkHttp 宽容一些会自己编码——一个"只在 iOS 上整批扫描失败"的差异 bug。
 */
function activeParam(addresses: readonly string[]): string {
  return addresses.map((a) => encodeURIComponent(a)).join("%7C");
}

async function fetchUnspentBatch(addresses: readonly string[]): Promise<BciUnspentOutput[]> {
  const active = activeParam(addresses);
  // 走 queuedFetch 而不是裸 safeFetch：
  //   1. 进程级并发闸门 —— 旧实现直接调 safeFetch，**完全绕过了 httpQueue**。
  //      金库详情页和发送页各自挂一个 useVault，两个 40 地址的扫描叠在一起，
  //      对同一个第三方 API 瞬间打出几十个请求，限流是必然的。
  //   2. in-flight GET 去重 —— 上面那两个页面查的是同一批地址，去重直接砍掉一半。
  //   3. 429/5xx 退避重试。
  const res = await queuedFetch(`${BASE}/unspent?active=${active}&limit=${UNSPENT_LIMIT}`, {
    timeoutMs: 12000,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 【灰按钮 / 余额忽有忽无的根因】旧实现把**任何** 500 都当成「这个地址没有
    // UTXO」直接返回空数组。而 500 同样是反代过载、上游限流、上游故障的状态码 ——
    // 于是「查不到」被静默翻译成「你没钱」。
    //
    // 只有两种 500 才算「真的没有可花输出」：响应体明说 No free outputs，
    // 或者反代把上游的错误体吃掉了只剩空响应（这是反代的常见行为，也是旧代码
    // 一直依赖的那条路径——不容忍它会把所有空地址变成硬错误）。
    // 其余一律抛错，交给上层如实报告「数据不完整」。
    if (res.status === 500 && (NO_FREE_OUTPUTS.test(body) || body.trim() === "")) return [];
    throw new Error(`blockchain.info unspent HTTP ${res.status}`);
  }
  const data = (await res.json()) as { unspent_outputs?: BciUnspentOutput[] };
  const list = data.unspent_outputs ?? [];
  if (list.length >= UNSPENT_LIMIT) {
    // 触顶意味着结果被截断，可花 UTXO 会少算 —— 必须让调用方知道，不能静默。
    throw new Error(`blockchain.info unspent truncated at ${UNSPENT_LIMIT}`);
  }
  return list;
}

/**
 * 拉单个地址的 UTXO，返回 mempool 格式兼容的 raw 数组（供 parseUtxoResponse 解析）。
 * 保留供单地址场景使用；多地址请走 fetchUtxosBatchBlockchainInfo（请求数少一个数量级）。
 */
export async function fetchUtxosRawBlockchainInfo(address: string): Promise<MempoolUtxoRaw[]> {
  return mapUnspentOutputs(await fetchUnspentBatch([address]));
}

/**
 * 批量拉多个地址的 UTXO，按地址归组返回。
 *
 * blockchain.info 的多地址响应不带地址字段，靠 `script`（scriptPubKey hex）归属。
 * 调用方传入 address → scriptHex 映射（本地派生，不信任 API 返回的地址字符串）。
 * 匹配不到 script 的条目会被丢弃并记警告 —— 宁可少算也不把陌生 UTXO 塞进钱包。
 */
export async function fetchUtxosBatchBlockchainInfo(
  addresses: readonly string[],
  scriptHexByAddress: ReadonlyMap<string, string>,
): Promise<Map<string, MempoolUtxoRaw[]>> {
  const byAddress = new Map<string, MempoolUtxoRaw[]>();
  for (const a of addresses) byAddress.set(a, []);
  if (addresses.length === 0) return byAddress;

  const addressByScript = new Map<string, string>();
  for (const [address, scriptHex] of scriptHexByAddress) {
    addressByScript.set(scriptHex.toLowerCase(), address);
  }

  const batches = chunkAddresses(addresses);
  // 批之间串行：blockchain.info 对单 IP 的突发很敏感，2~3 个请求串行也只要 1 秒上下。
  for (const batch of batches) {
    const raw = mapUnspentOutputs(await fetchUnspentBatch(batch));
    let matched = 0;
    for (const utxo of raw) {
      const address = utxo.scriptHex ? addressByScript.get(utxo.scriptHex) : undefined;
      if (!address) continue;
      byAddress.get(address)?.push(utxo);
      matched++;
    }
    // 上游给了输出、却**一条都对不上**我们本地派生的 scriptPubKey —— 这不是
    // "这些地址没钱"，而是归属逻辑失效（上游改了 script 字段格式、反代改写了
    // 响应、地址集合传错）。静默返回空集会把它伪装成余额为 0；必须抛错，
    // 让上层退回逐地址路径并如实标记数据不完整。
    if (raw.length > 0 && matched === 0) {
      logger.warn("Unspent batch returned outputs but none matched local scripts", {
        outputs: raw.length,
        addresses: batch.length,
      });
      throw new Error("blockchain.info unspent: no outputs matched local scripts");
    }
  }
  return byAddress;
}

export type BlockchainInfoAddressState = {
  balanceSats: number;
  txCount: number;
  transactions: Array<{ txid: string; confirmed: boolean; valueSats: number; time?: number }>;
};

/**
 * 拉地址余额 + 最近交易，适配成 mempool 兼容的 ChainState 子集。
 * final_balance 为确认余额；txs 的 result 字段是对该地址的净金额（正=收入，负=支出）。
 */
export async function fetchAddressStateBlockchainInfo(
  address: string,
): Promise<BlockchainInfoAddressState> {
  const res = await queuedFetch(`${BASE}/rawaddr/${address}?limit=50`, { timeoutMs: 8000 });
  if (!res.ok) throw new Error(`blockchain.info rawaddr HTTP ${res.status}`);
  const data = (await res.json()) as {
    final_balance: number;
    n_tx: number;
    txs?: Array<{ hash: string; result: number; time: number; block_height: number }>;
  };
  return {
    balanceSats: data.final_balance ?? 0,
    txCount: data.n_tx ?? 0,
    transactions: (data.txs ?? []).slice(0, 20).map((tx) => ({
      txid: tx.hash,
      confirmed: tx.block_height > 0,
      valueSats: tx.result,
      time: tx.time,
    })),
  };
}

export type BlockchainInfoWalletState = {
  /** 整个地址集合的合计余额（含未确认）。 */
  balanceSats: number;
  txCount: number;
  transactions: Array<{ txid: string; confirmed: boolean; valueSats: number; time?: number }>;
};

type BciMultiaddr = {
  wallet?: { final_balance?: number; n_tx?: number };
  addresses?: Array<{ address?: string; final_balance?: number; n_tx?: number }>;
  txs?: Array<{ hash?: string; result?: number; time?: number; block_height?: number }>;
};

/**
 * 一次拿到**整组地址**的余额与近期交易（/multiaddr?active=a|b|c）。
 *
 * 与逐地址 /rawaddr 相比：42 次请求 → 2~3 次。这不只是快，更重要的是
 * **不再被限流**，从而不再出现「每次刷新少算的地址不同 → 余额跳变」。
 *
 * 注意 txs[].result 已经是**对整组地址的净额**，调用方不要再按地址累加。
 */
export async function fetchWalletStateBlockchainInfo(
  addresses: readonly string[],
): Promise<BlockchainInfoWalletState> {
  let balanceSats = 0;
  let txCount = 0;
  const merged = new Map<string, { txid: string; confirmed: boolean; valueSats: number; time?: number }>();

  for (const batch of chunkAddresses(addresses)) {
    const res = await queuedFetch(`${BASE}/multiaddr?active=${activeParam(batch)}&n=50`, {
      timeoutMs: 12000,
    });
    if (!res.ok) throw new Error(`blockchain.info multiaddr HTTP ${res.status}`);
    const data = (await res.json()) as BciMultiaddr;

    const walletBalance = data.wallet?.final_balance;
    if (Number.isFinite(walletBalance)) {
      balanceSats += Number(walletBalance);
    } else {
      // 没有 wallet 汇总时退回逐地址累加。
      for (const a of data.addresses ?? []) {
        if (Number.isFinite(a.final_balance)) balanceSats += Number(a.final_balance);
      }
    }
    txCount += Number(data.wallet?.n_tx ?? 0);

    for (const tx of data.txs ?? []) {
      if (typeof tx.hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(tx.hash)) continue;
      const txid = tx.hash.toLowerCase();
      const height = Number(tx.block_height ?? 0);
      const entry = {
        txid,
        confirmed: Number.isFinite(height) && height > 0,
        valueSats: Number.isFinite(tx.result) ? Number(tx.result) : 0,
        time: Number.isFinite(tx.time) ? Number(tx.time) : undefined,
      };
      const existing = merged.get(txid);
      if (existing) {
        // 跨批次同一笔交易：result 是各自批次内地址集合的净额，可以相加。
        existing.valueSats += entry.valueSats;
        if (entry.confirmed) existing.confirmed = true;
        if (existing.time === undefined) existing.time = entry.time;
      } else {
        merged.set(txid, entry);
      }
    }
  }

  return { balanceSats, txCount: Math.max(txCount, merged.size), transactions: Array.from(merged.values()) };
}

/** 广播结果。txid 为 null 表示节点确认收下但未回 txid（由调用方用本地计算值兜底）。 */
export type BroadcastOutcome = { txid: string | null };

/** blockchain.info/pushtx 成功时的文本应答（不是 txid）。 */
const PUSHTX_ACCEPTED = /transaction\s+submitted|success/i;
/**
 * 「这笔交易节点已经有了」——语义上等同于广播成功，绝不能报错给用户。
 * 旧实现把它当失败，用户会以为没发出去而重复点击。
 */
const ALREADY_KNOWN =
  /already\s+(in|known|have)|txn-already|transaction\s+already|duplicate/i;

export function isAlreadyBroadcast(message: string): boolean {
  return ALREADY_KNOWN.test(message);
}

/** 从错误文本里抹掉 64 位 hex（txid），避免沿调用链泄露到 UI / 日志。 */
export function redactTxids(text: string): string {
  return text.replace(/[0-9a-fA-F]{64}/g, "<txid>");
}

/**
 * 广播已签交易。走东京反代 blockchain.info/pushtx（国内可达 + 稳，
 * mempool.space 直连 POST 在国内被 400 拒）。
 *
 * 【旧实现的漏洞】blockchain.info/pushtx **成功时返回的是 "Transaction Submitted"
 * 这段文本，不是 txid**。旧代码用 `/^[0-9a-f]{64}$/` 去校验应答，于是把成功当成
 * 失败抛出，接着 fallback 打 mempool.space —— 而这笔交易此刻已经在 mempool 里了，
 * mempool 以 400 "txn-already-in-mempool" 拒绝。用户看到「发送失败 400」，
 * 实际上钱已经发出去了。这是安卓端 400 的第二个成因。
 */
export async function broadcastBlockchainInfo(rawHex: string): Promise<BroadcastOutcome> {
  const res = await safeFetch(`${BASE}/pushtx`, {
    method: "POST",
    body: `tx=${rawHex}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }, 20000);
  const text = (await res.text().catch(() => "")).trim();

  if (!res.ok) {
    // 节点说「这笔我已经有了」= 广播成功，不是失败。
    if (isAlreadyBroadcast(text)) return { txid: null };
    const safe = redactTxids(text).slice(0, 200);
    throw new Error(`blockchain.info pushtx HTTP ${res.status}${safe ? `: ${safe}` : ""}`);
  }
  // 应答可能是 txid，也可能是 "Transaction Submitted" 之类的确认文本。
  if (/^[0-9a-f]{64}$/i.test(text)) return { txid: text.toLowerCase() };
  if (text === "" || PUSHTX_ACCEPTED.test(text) || isAlreadyBroadcast(text)) {
    return { txid: null };
  }
  throw new Error(`blockchain.info pushtx rejected: ${redactTxids(text).slice(0, 200)}`);
}
