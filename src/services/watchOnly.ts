import * as btc from "@scure/btc-signer";
import { getBtcNetwork, getNetworkModeSync } from "./network-mode";
import { fetchBitcoinApi } from "./network";
import { buildPsbtCore, scanUtxosBatched, selectInputs, type UTXO } from "./transaction";
import { GAP_LIMIT, parseBip32Path } from "./wallet";
import { DUST_THRESHOLD_SATS, validateBtcAddress } from "../utils/bitcoin";
import { clampFeeRate } from "./feePolicy";
import { assertComplete, type FanoutResult } from "./fanout";
import { parseExtKey } from "./extkey";
import AsyncStorage from "@react-native-async-storage/async-storage";

// 观察钱包上下文：zpub（account-level）+ account fingerprint + account derivation。
// 全部为公开信息，无私钥。fingerprint 取 account 节点（zpub 能计算的最高层级）。
export type WatchOnlyContext = {
  zpub: string;
  fingerprint: number;
  accountDerivation: string;  // "m/84'/0'/0'"
};

// 带派生信息的 UTXO：watch-only 端构造 PSBT 时据此组装 bip32Derivation。
export type WatchUtxo = UTXO & { isChange: boolean; index: number };

export type WatchBuiltPsbt = {
  psbtB64: string;
  changeIdx: number;
  feeSats: number;
  inputCount: number;
};

export function deriveWatchAddresses(zpub: string, count: number, isChange: boolean): string[] {
  const account = parseExtKey(zpub);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const child = account.derive(`m/${isChange ? 1 : 0}/${i}`);
    if (!child.publicKey) throw new Error(`Could not derive pubkey at ${isChange ? 1 : 0}/${i}`);
    const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
    if (!payment.address) throw new Error("Could not derive watch address");
    out.push(payment.address);
  }
  return out;
}

// 从 zpub 派生 receive/change 地址，逐个查公开 UTXO 端点。无私钥。
// includeUnconfirmed=true：广播后找零通常是未确认 UTXO，若只取 confirmed 会导致
// 余额在下一区块前显示为 0（"广播后金额消失"bug）。观察余额应包含未确认。
/**
 * 扫描观察钱包的 UTXO，**有界并发 + 如实报告完整性**。
 *
 * 【旧实现的两个问题】
 *   1. 完全串行：`await` 在双层 for 循环里，gap limit 20 之后是 40+ 次串行往返，
 *      移动网络下一次余额刷新要好几十秒。
 *   2. `.catch(() => [])`：限流失败的地址被当成"没有 UTXO"，余额少算且无提示。
 */
export async function scanWatchUtxosDetailed(
  zpub: string,
  gapLimit = GAP_LIMIT,
): Promise<FanoutResult<WatchUtxo>> {
  const account = parseExtKey(zpub);
  // change 扫描范围覆盖已持久化的最高找零索引 + gap，确保找零地址余额可见（P0-5）
  const persistedMaxChange = await readWatchChangeIdx(zpub);
  const changeUpper = Math.max(gapLimit, persistedMaxChange + gapLimit) + 1;

  type Slot = { isChange: boolean; index: number; address: string };
  const slots: Slot[] = [];
  for (const isChange of [false, true]) {
    const upper = isChange ? changeUpper : gapLimit + 1;
    for (let i = 0; i < upper; i++) {
      const child = account.derive(`m/${isChange ? 1 : 0}/${i}`);
      if (!child.publicKey) continue;
      const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
      if (!payment.address) continue;
      slots.push({ isChange, index: i, address: payment.address });
    }
  }

  // 批量扫描（40+ 地址 → 2~3 次请求）。逐地址查询会被第三方 API 限流，
  // 失败的地址每次不同 → 观察余额跳变。
  const result = await scanUtxosBatched(slots.map((s) => s.address));
  const slotByAddress = new Map(slots.map((s) => [s.address, s]));
  return {
    ...result,
    data: result.data.flatMap<WatchUtxo>((u) => {
      const slot = slotByAddress.get(u.address);
      return slot ? [{ ...u, isChange: slot.isChange, index: slot.index }] : [];
    }),
  };
}

/** @deprecated 丢失完整性信息，仅供只读展示。 */
export async function scanWatchUtxos(zpub: string, gapLimit = GAP_LIMIT): Promise<WatchUtxo[]> {
  return (await scanWatchUtxosDetailed(zpub, gapLimit)).data;
}

export async function fetchWatchBalanceSats(zpub: string): Promise<number> {
  const utxos = await scanWatchUtxos(zpub);
  return utxos.reduce((s, u) => s + u.value, 0);
}

// watch-only 找零索引持久化（P0-5）：记录已用的最高 change index，
// 防下次找零越 scan 范围导致余额"消失"。key 按 zpub 隔离。
function watchChangeIdxKey(zpub: string): string {
  return `bitnest.watch.changeIdx.${zpub}`;
}
async function readWatchChangeIdx(zpub: string): Promise<number> {
  const raw = await AsyncStorage.getItem(watchChangeIdxKey(zpub));
  const n = raw ? Number.parseInt(raw, 10) : -1;
  return Number.isFinite(n) && n >= -1 ? n : -1;
}
export async function commitWatchChangeIdx(zpub: string, idx: number): Promise<void> {
  if (!Number.isFinite(idx) || idx < 0) return;
  const cur = await readWatchChangeIdx(zpub);
  if (idx > cur) await AsyncStorage.setItem(watchChangeIdxKey(zpub), String(idx));
}

// watch-only 端构造未签 PSBT。与 transaction.buildUnsignedPsbt 同构，区别：
//  - fingerprint/path 由 zpub + child index 组装（无私钥）
//  - 不维护本机派生索引；找零用扫到的最大 change idx + 1
//  - 不递增任何本地状态（watch-only 端不持久化 idx）
export async function buildWatchPsbt(
  ctx: WatchOnlyContext,
  recipientAddress: string,
  amountSats: number,
  feeRate: number,
): Promise<WatchBuiltPsbt> {
  if (!validateBtcAddress(recipientAddress)) throw new Error("invalid recipient address");

  const account = parseExtKey(ctx.zpub);
  const base = parseBip32Path(ctx.accountDerivation);

  // 构造交易必须用完整的 UTXO 集合，部分失败直接抛错让用户重试。
  const allUtxos = assertComplete(await scanWatchUtxosDetailed(ctx.zpub));
  const ownAddresses = new Set(allUtxos.map((u) => u.address));
  if (ownAddresses.has(recipientAddress)) throw new Error("self-send not allowed");

  // 与单签 / 多签共用同一个钳制区间。旧实现这里独立钳到 5000，
  // 而离线签名端拒绝 >500 sat/vB —— 观察钱包造出来的 PSBT 签名终端签不了。
  const clampedFeeRate = clampFeeRate(feeRate);
  const { selected, fee, changeAmount } = selectInputs(allUtxos, amountSats, clampedFeeRate);

  let changeIdx = 0;
  let changeAddress: string | null = null;
  if (changeAmount > DUST_THRESHOLD_SATS) {
    const maxSelectedChange = selected.filter((u) => u.isChange).reduce((m, u) => Math.max(m, u.index), -1);
    // 取已持久化最高 change idx 与本次所选的最大值 +1，避免重用且不越扫描范围（P0-5）
    const persistedMax = await readWatchChangeIdx(ctx.zpub);
    changeIdx = Math.max(persistedMax, maxSelectedChange) + 1;
    const changeChild = account.derive(`m/1/${changeIdx}`);
    if (!changeChild.publicKey) throw new Error("Could not derive change pubkey");
    const changePayment = btc.p2wpkh(changeChild.publicKey, getBtcNetwork());
    if (!changePayment.address) throw new Error("Could not derive change address");
    changeAddress = changePayment.address;
  }

  const { psbtB64, inputCount } = await buildPsbtCore({
    recipient: recipientAddress,
    amountSats,
    selected,
    changeAmount,
    changeAddress,
    buildInput: (utxo) => {
      const wu = utxo as WatchUtxo;
      const path = [...base, wu.isChange ? 1 : 0, wu.index];
      const child = account.derive(`m/${wu.isChange ? 1 : 0}/${wu.index}`);
      if (!child.publicKey) throw new Error("Could not derive input pubkey");
      return {
        script: utxo.script,
        bip32Derivation: [[child.publicKey, { fingerprint: ctx.fingerprint, path }]],
      };
    },
  });

  return { psbtB64, changeIdx, feeSats: fee, inputCount };
}

// 观察钱包交易列表项：txid + 是否确认 + 净变动(正=收款/负=发送) + 区块时间。
export type WatchTx = {
  txid: string;
  confirmed: boolean;
  valueSats: number;
  time?: number; // 区块时间（unix 秒）；未确认为 undefined
};

// 拉取观察地址的近期交易（聚合 receive/change 各 gapLimit 个地址）。
// 同一笔交易可能触碰多个本机地址，按 txid 去重并合并净变动。
export async function fetchWatchTransactions(zpub: string, gapLimit = GAP_LIMIT): Promise<WatchTx[]> {
  const account = parseExtKey(zpub);
  const merged = new Map<string, WatchTx>();
  for (const isChange of [false, true]) {
    for (let i = 0; i < gapLimit + 1; i++) {
      const child = account.derive(`m/${isChange ? 1 : 0}/${i}`);
      if (!child.publicKey) continue;
      const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
      if (!payment.address) continue;
      try {
        const res = await fetchBitcoinApi(`/address/${payment.address}/txs`);
        const arr = await res.json();
        if (!Array.isArray(arr)) continue;
        for (const tx of arr as any[]) {
          if (typeof tx?.txid !== "string") continue;
          const incoming = (Array.isArray(tx.vout) ? tx.vout : [])
            .filter((o: any) => o?.scriptpubkey_address === payment.address)
            .reduce((s: number, o: any) => s + (typeof o?.value === "number" ? o.value : 0), 0);
          const outgoing = (Array.isArray(tx.vin) ? tx.vin : [])
            .filter((inp: any) => inp?.prevout?.scriptpubkey_address === payment.address)
            .reduce((s: number, inp: any) => s + (typeof inp?.prevout?.value === "number" ? inp.prevout.value : 0), 0);
          const valueSats = incoming - outgoing;
          const blockTime = typeof tx?.status?.block_time === "number" ? tx.status.block_time : undefined;
          const existing = merged.get(tx.txid);
          if (existing) {
            existing.valueSats += valueSats;
            // 任一地址上已确认即视为已确认
            if (tx?.status?.confirmed) existing.confirmed = true;
            if (blockTime !== undefined && existing.time === undefined) existing.time = blockTime;
          } else {
            merged.set(tx.txid, {
              txid: tx.txid,
              confirmed: Boolean(tx?.status?.confirmed),
              valueSats,
              time: blockTime,
            });
          }
        }
      } catch {
        // 单地址失败不影响整体
      }
    }
  }
  // 简单按 txid 字典序倒序（esplora 通常已按时间倒序，跨地址聚合后近似最新在前）
  return Array.from(merged.values()).sort((a, b) => (a.txid < b.txid ? 1 : -1));
}

// 交易在区块链浏览器上的 URL（点击交易列表项跳转用）。
export function watchTxExplorerUrl(txid: string): string {
  const base = getNetworkModeSync() === "testnet"
    ? "https://mempool.space/testnet/tx/"
    : "https://mempool.space/tx/";
  return `${base}${txid}`;
}
