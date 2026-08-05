import AsyncStorage from "@react-native-async-storage/async-storage";
import { integrityTag, verifyIntegrityTag } from "./crypto";
import { fetchBitcoinApi } from "./network";
import { fetchAddressStateBlockchainInfo, fetchWalletStateBlockchainInfo } from "./blockchainInfo";
import { saveTransactions } from "./database";
import { scanWalletAddresses, getWalletDataKey } from "./wallet";
import { safeFetch } from "./hosts";
import { fanout } from "./fanout";
import { logger } from "./logger";

export type ChainState = {
  balanceSats: number;
  txCount: number;
  transactions: Array<{
    txid: string;
    confirmed: boolean;
    valueSats: number;
    time?: number; // 区块时间（unix 秒）；未确认为 undefined
  }>;
  /**
   * 本次扫描是否覆盖了全部地址。
   * false 表示 balanceSats 是**下界**（部分地址查询失败，通常是第三方 API 限流），
   * UI 必须提示"数据不完整"而不是照常显示。缺这个字段正是旧实现把
   * "查不到"静默降级成"没有钱"的根源。
   */
  complete?: boolean;
};

const WALLET_CACHE_KEY = "bitnest.wallet.cache";
const PRICE_CACHE_KEY = "bitnest.price.cny.cache";
const PRICE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStats(json: any, key: "chain_stats" | "mempool_stats") {
  const stats = json?.[key];
  if (
    !stats ||
    !isNumber(stats.funded_txo_sum) ||
    !isNumber(stats.spent_txo_sum) ||
    !isNumber(stats.tx_count)
  ) {
    throw new Error("Invalid address response");
  }
  return stats;
}

async function fetchAddressState(address: string): Promise<ChainState> {
  try {
    // 主路径：东京反代 blockchain.info（国内可达 + ~0.3s 稳定）
    const bi = await fetchAddressStateBlockchainInfo(address);
    const state: ChainState = {
      balanceSats: bi.balanceSats,
      txCount: bi.txCount,
      transactions: bi.transactions,
    };
    await saveTransactions(address, state.transactions).catch((error) => {
      logger.warn("Failed to save transactions to SQLite", error);
    });
    return state;
  } catch (bciErr) {
    // fallback：东京反代失败时试 mempool/blockstream（不稳但兜底）
    const [addressRes, txRes] = await Promise.all([
      fetchBitcoinApi(`/address/${address}`),
      fetchBitcoinApi(`/address/${address}/txs`)
    ]);

    const addressJson = await addressRes.json();
    const txJson = await txRes.json();
    if (!Array.isArray(txJson)) throw new Error("Invalid transaction response");

    const chainStats = readStats(addressJson, "chain_stats");
    const mempoolStats = readStats(addressJson, "mempool_stats");
    const funded = chainStats.funded_txo_sum + mempoolStats.funded_txo_sum;
    const spent = chainStats.spent_txo_sum + mempoolStats.spent_txo_sum;

    const state: ChainState = {
      balanceSats: funded - spent,
      txCount: chainStats.tx_count + mempoolStats.tx_count,
      transactions: txJson.slice(0, 20).filter((tx: any) => (
        typeof tx?.txid === "string" &&
        Array.isArray(tx.vout) &&
        Array.isArray(tx.vin)
      )).map((tx: { txid: string; status?: { confirmed: boolean; block_time?: number }; vout: Array<{ scriptpubkey_address?: string; value?: number }>; vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }> }) => {
        const incoming = tx.vout
          .filter((out) => out.scriptpubkey_address === address)
          .reduce((sum: number, out) => sum + (isNumber(out.value) ? out.value : 0), 0);
        const outgoing = tx.vin
          .filter((input) => input.prevout?.scriptpubkey_address === address)
          .reduce((sum: number, input) => sum + (isNumber(input.prevout?.value) ? input.prevout.value : 0), 0);
        return {
          txid: tx.txid,
          confirmed: Boolean(tx.status?.confirmed),
          valueSats: incoming - outgoing,
          time: isNumber(tx.status?.block_time) ? tx.status!.block_time : undefined,
        };
      })
    };

    await saveTransactions(address, state.transactions).catch((error) => {
      logger.warn("Failed to save transactions to SQLite", error);
    });
    return state;
  }
}

/** 至少需要这么多个数据源成功，才认为中位数可信。 */
const MIN_PRICE_SOURCES = 3;
/** 偏离中位数超过此比例的源视为异常并告警。 */
const PRICE_OUTLIER_RATIO = 0.1;

/** 返回 null 表示价格不可用——调用方必须显式处理，不要用兜底数字糊弄用户。 */
export async function fetchBtcCnyPrice(): Promise<number | null> {
  async function fetchJson(url: string, timeoutMs = 9000) {
    const res = await safeFetch(url, {}, timeoutMs);
    if (!res.ok) throw new Error(`Price endpoint failed: ${res.status}`);
    return await res.json();
  }

  async function fetchUsdCnyRate(): Promise<number> {
    const json = await fetchJson("https://open.er-api.com/v6/latest/USD");
    const rate = Number(json?.rates?.CNY);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid USD/CNY response");
    return rate;
  }

  async function readCachedPrice(): Promise<number | null> {
    const raw = await AsyncStorage.getItem(PRICE_CACHE_KEY).catch(() => null);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: number; fetchedAt?: number };
    if (!isNumber(parsed.value) || !isNumber(parsed.fetchedAt)) return null;
    if (Date.now() - parsed.fetchedAt > PRICE_CACHE_MAX_AGE_MS) return null;
    return parsed.value;
  }

  async function cachePrice(value: number): Promise<number> {
    await AsyncStorage.setItem(PRICE_CACHE_KEY, JSON.stringify({ value, fetchedAt: Date.now() })).catch((error) => {
      logger.warn("Failed to cache BTC price", error);
    });
    return value;
  }

  const loaders = [
    async () => {
      const json = await fetchJson("https://api.coinbase.com/v2/prices/BTC-CNY/spot");
      return Number(json?.data?.amount);
    },
    async () => {
      const json = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=cny");
      return Number(json?.bitcoin?.cny);
    },
    async () => {
      const json = await fetchJson("https://api.coinpaprika.com/v1/tickers/btc-bitcoin?quotes=CNY");
      return Number(json?.quotes?.CNY?.price);
    },
    async () => {
      const json = await fetchJson("https://blockchain.info/ticker");
      return Number(json?.CNY?.last ?? json?.CNY?.["15m"]);
    },
    async () => {
      const [priceJson, usdCny] = await Promise.all([
        fetchJson("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT"),
        fetchUsdCnyRate()
      ]);
      return Number(priceJson?.data?.[0]?.last) * usdCny;
    },
    async () => {
      const [priceJson, usdCny] = await Promise.all([
        fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
        fetchUsdCnyRate()
      ]);
      return Number(priceJson?.price) * usdCny;
    },
    async () => {
      const [priceJson, usdCny] = await Promise.all([
        fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot"),
        fetchUsdCnyRate()
      ]);
      return Number(priceJson?.data?.amount) * usdCny;
    }
  ];
  // 多源取中位数，而非「第一个成功就返回」。
  //
  // 旧实现是顺序 failover：只要污染/劫持 coinbase 一家，用户看到的就是假价格。
  // 7 个源取中位数后，攻击者需要同时污染 4 家才能移动结果——这个防护强度是
  // 证书固定给不了的，而且不会因为对方例行换证而失效。
  const settled = await Promise.allSettled(loaders.map((load) => load()));
  const prices = settled
    .filter((r): r is PromiseFulfilledResult<number> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);

  if (prices.length >= MIN_PRICE_SOURCES) {
    const median = prices[Math.floor(prices.length / 2)];
    // 偏离中位数超过阈值的源记录告警——持续出现说明某个源被投毒或已失效
    const outliers = prices.filter((p) => Math.abs(p - median) / median > PRICE_OUTLIER_RATIO);
    if (outliers.length > 0) {
      logger.warn("Price sources disagree beyond threshold", {
        median,
        outlierCount: outliers.length,
        total: prices.length,
      });
    }
    return cachePrice(median);
  }

  logger.warn("Insufficient price sources", { got: prices.length, need: MIN_PRICE_SOURCES });
  const cached = await readCachedPrice();
  if (cached) return cached;
  // 全部源失败且无缓存 → 明确返回 null，由 UI 显示「价格不可用」。
  // 旧实现返回一个硬编码的过期价格（432000），让用户拿着编造的数字做购买决策。
  return null;
}

export async function fetchFeeEstimates(): Promise<{ slow: number; medium: number; fast: number }> {
  const res = await fetchBitcoinApi("/fee-estimates");
  const json = await res.json();
  if (!json || typeof json !== "object") throw new Error("Invalid fee response");
  return {
    slow: Math.max(1, Math.round(json["144"] ?? 2)),
    medium: Math.max(1, Math.round(json["6"] ?? 5)),
    fast: Math.max(1, Math.round(json["2"] ?? 20))
  };
}

type AggregatedTx = { txid: string; confirmed: boolean; valueSats: number; time?: number };

function mergeTxStates(states: ChainState[]): AggregatedTx[] {
  const merged = new Map<string, AggregatedTx>();
  for (const state of states) {
    for (const tx of state.transactions) {
      const existing = merged.get(tx.txid);
      if (existing) {
        existing.valueSats += tx.valueSats;
      } else {
        merged.set(tx.txid, { ...tx });
      }
    }
  }
  return Array.from(merged.values());
}

// Deterministic ordering so the home screen's "recent 3" doesn't reshuffle on
// every refresh. Map-merge above only guarantees dedupe, not order (multi-address
// scans insert in batch order). Rule: pending (no block time yet) first, then
// confirmed by block_time descending, with txid as a stable tie-breaker.
function sortTransactions(txs: AggregatedTx[]): AggregatedTx[] {
  return txs.sort((a, b) => {
    const aPending = a.time === undefined;
    const bPending = b.time === undefined;
    if (aPending !== bPending) return aPending ? -1 : 1;
    const at = a.time ?? 0;
    const bt = b.time ?? 0;
    if (at !== bt) return bt - at;
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  });
}

export async function fetchWalletState(): Promise<ChainState> {
  const addresses = await scanWalletAddresses();

  // 【首选】一次请求拿整组地址（/multiaddr?active=a|b|c）。
  //
  // 逐地址查询在 gap limit 20 下是 42 次 HTTP，第三方公共 API 必然限流其中若干次，
  // 而部分失败被容忍展示 → **每次刷新失败的地址不同，余额就跳变**。批量把请求数
  // 压到 2~3 次，限流概率接近零，余额随之稳定。
  try {
    const batched = await fetchWalletStateBlockchainInfo(addresses.map((a) => a.address));
    const transactions = sortTransactions(batched.transactions).slice(0, 20);
    const state: ChainState = {
      balanceSats: batched.balanceSats,
      txCount: batched.txCount,
      transactions,
      complete: true,
    };
    await cacheWalletState(addresses[0]?.address, state);
    return state;
  } catch (err) {
    logger.warn("Batched wallet state failed, falling back to per-address", err);
  }

  // 走统一的 fanout（有界并发 + 完整性计数），不再手写分批 + catch(()=>null)。
  const scan = await fanout(addresses, async ({ address }) => [await fetchAddressState(address)]);
  const valid = scan.data;
  // A transient blip that fails every address fetch must NOT overwrite the
  // cached chain with an all-zero state (which would blank the balance and
  // history on the home screen). Throwing here lets useBlockchain.refresh keep
  // the previous good snapshot.
  if (valid.length === 0) {
    throw new Error("Failed to fetch any address state");
  }
  if (!scan.complete) {
    // 部分成功：余额是**下界**，不是真值。展示可以继续（比整个界面空白好），
    // 但必须把这个事实带给 UI —— 旧实现在这里完全静默，用户看到的是一个
    // 看起来正常、实际偏低的余额。发送路径另有 assertComplete 兜底。
    logger.warn("Partial wallet state scan", { failed: scan.failed, total: scan.total });
  }
  const balanceSats = valid.reduce((sum, state) => sum + state.balanceSats, 0);
  // txCount 必须按 txid 去重：一笔同时命中钱包两个地址的交易，旧实现会计两次
  // （transactions 列表按 txid 去重了，txCount 没有）。
  const merged = mergeTxStates(valid);
  const txCount = merged.length;
  const transactions = sortTransactions(merged).slice(0, 20);

  const state: ChainState = { balanceSats, txCount, transactions, complete: scan.complete };
  await cacheWalletState(addresses[0]?.address, state);
  return state;
}

async function cacheWalletState(firstAddress: string | undefined, state: ChainState): Promise<void> {
  const cacheKey = `${WALLET_CACHE_KEY}.${firstAddress ?? "unknown"}`;
  const raw = JSON.stringify(state);
  // 缓存完整性标签：HMAC-SHA256，密钥从钱包 root 派生。
  // 旧实现是 SHA256(硬编码盐 + 数据)——盐在 App bundle 里，能改缓存的攻击者
  // 同样能算出新哈希，只防损坏不防篡改。HMAC 的密钥攻击者拿不到。
  const hashKey = `${cacheKey}.hash`;
  try {
    const key = await getWalletDataKey();
    await AsyncStorage.multiSet([
      [cacheKey, raw],
      [hashKey, integrityTag(key, raw)],
    ]);
  } catch (error) {
    logger.warn("Failed to cache wallet state", error);
  }
}

export async function getCachedWalletState(address: string): Promise<ChainState | null> {
  const key = `${WALLET_CACHE_KEY}.${address}`;
  const hashKey = `${key}.hash`;
  const [raw, storedHash] = await Promise.all([
    AsyncStorage.getItem(key).catch(() => null),
    AsyncStorage.getItem(hashKey).catch(() => null),
  ]);
  if (!raw) return null;
  // 完整性校验：如果有哈希记录（v2+），验证数据未被篡改
  if (storedHash) {
    let ok = false;
    try {
      ok = verifyIntegrityTag(await getWalletDataKey(), raw, storedHash);
    } catch {
      // 钱包锁定时拿不到派生密钥：无法验证就不使用缓存
      return null;
    }
    if (!ok) {
      logger.warn("Cache integrity check failed, discarding");
      await AsyncStorage.multiRemove([key, hashKey]).catch(() => {});
      return null;
    }
  } else {
    // 无标签的缓存一律不信任（旧版本残留 / 被植入）
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Validate shape: a half-written or cross-version cache must not reach render
  // with undefined fields (e.g. missing `transactions`), or HomeScreen's
  // `(chain?.transactions ?? []).slice` would still be safe but downstream
  // consumers assume the contract. Reject anything that isn't a well-formed
  // ChainState so the app refetches instead of crashing.
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as ChainState).transactions) ||
    typeof (parsed as ChainState).balanceSats !== "number"
  ) {
    return null;
  }
  return parsed as ChainState;
}

export async function clearCachedWalletState(address?: string): Promise<void> {
  if (address) {
    const key = `${WALLET_CACHE_KEY}.${address}`;
    await AsyncStorage.multiRemove([key, `${key}.hash`]).catch((error) => {
      logger.warn("Failed to clear wallet cache", error);
    });
  }
  await AsyncStorage.multiRemove([WALLET_CACHE_KEY, `${WALLET_CACHE_KEY}.hash`]).catch((error) => {
    logger.warn("Failed to clear wallet cache", error);
  });
}

/**
 * nLockTime 的区块高度域上界。
 *
 * 【为什么必须钳制】Bitcoin 共识规则：nLockTime < 500,000,000 解释为**区块高度**，
 * ≥ 500,000,000 解释为 **Unix 时间戳**。旧实现只校验 `height > 0`，数据源又是
 * 不做交叉验证的第三方 API —— 一个被投毒或出故障的节点返回 1700000000，
 * 构造出的交易 nLockTime 就落进时间戳域，在 2023-11 之前……实际是**该时间戳
 * 到达前完全无法上链**。用户的钱被自己的钱包锁住数年。
 *
 * 上界取 1000 万：主网当前约 90 万、testnet3 已过 280 万（所以不能取 200 万），
 * 而 1000 万仍比时间戳阈值 5 亿低 50 倍，留足了安全边际。
 */
const LOCKTIME_HEIGHT_DOMAIN_MAX = 500_000_000;
const MAX_PLAUSIBLE_BLOCK_HEIGHT = 10_000_000;
/** 低于此值几乎必然是脏数据。 */
const MIN_PLAUSIBLE_BLOCK_HEIGHT = 1;

/**
 * 获取当前区块高度，用于设置 nLockTime 防止费狙击攻击。
 * 拿不到或数值不可信时返回 0，调用方跳过 locktime 设置——
 * **少一层费狙击防护，好过把交易锁死。**
 */
export async function fetchBlockHeight(): Promise<number> {
  try {
    const res = await fetchBitcoinApi("/blocks/tip/height");
    const json = await res.json();
    const height = typeof json === "number" ? json : Number(json);
    if (!Number.isInteger(height)) return 0;
    if (
      height < MIN_PLAUSIBLE_BLOCK_HEIGHT ||
      height > MAX_PLAUSIBLE_BLOCK_HEIGHT ||
      height >= LOCKTIME_HEIGHT_DOMAIN_MAX
    ) {
      logger.warn("Implausible block height from API, skipping nLockTime", { height });
      return 0;
    }
    return height;
  } catch {
    return 0;
  }
}
