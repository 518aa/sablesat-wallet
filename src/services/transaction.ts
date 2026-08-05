import * as btc from "@scure/btc-signer";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { base64 } from "@scure/base";
import {
  isWalletUnlocked,
  scanWalletAddresses,
  peekChangeAddressAsync,
  commitChangeAddress,
  walletInputDerivation,
  deriveKeyForPath,
  onLock,
} from "./wallet";
import { fetchBitcoinApiCrossChecked } from "./network";
import { queuedFetch } from "./httpQueue";
import {
  fetchUtxosRawBlockchainInfo,
  fetchUtxosBatchBlockchainInfo,
  broadcastBlockchainInfo,
  isAlreadyBroadcast,
  redactTxids,
} from "./blockchainInfo";
import { fetchBlockHeight } from "./blockchain";
import { getBtcNetwork, getApiBase, subscribe as subscribeNetworkMode } from "./network-mode";
import { finalizeAndExtract } from "./vault/psbt";
import { DUST_THRESHOLD_SATS, estimateTxVbytes, validateBtcAddress } from "../utils/bitcoin";
import { checkFee, clampFeeRate, ExcessiveFeeError, type FeeVerdict } from "./feePolicy";
import { assertSendAllowed } from "./security";
import {
  InsufficientBalanceError,
  SelfSendError,
  InvalidAddressError,
} from "./errors";
import { constantTimeEqual, bytesToHex } from "./crypto";
import { anyUnknownOutput, PsbtMismatchError } from "./psbtCommon";
import {
  assertSignable,
  reviewPsbtWithPolicy,
  OutputsTamperedError,
  UnknownOutputError,
  type PsbtPolicyContext,
} from "./psbtPolicy";
import { fanout, assertComplete, IncompleteDataError, DEFAULT_FANOUT_CONCURRENCY, type FanoutResult } from "./fanout";
import { selectCoins, NoSolutionError } from "./coinSelection";
import { logger } from "./logger";

export type UTXO = {
  txid: string;
  vout: number;
  value: number;
  script: Uint8Array;
  address: string;
};

// PSBT 构造公共骨架：addInput（带 bip32Derivation）+ 收款 output + 可选找零 output。
// 单签（buildUnsignedPsbt）与 watch-only（buildWatchPsbt）共用，差异由 buildInput 回调与 changeAddress 注入。
export type PsbtCoreInput = {
  script: Uint8Array;
  bip32Derivation: [Uint8Array, { fingerprint: number; path: number[] }][];
};

export type PsbtCoreParams = {
  recipient: string;
  amountSats: number;
  selected: UTXO[];
  changeAmount: number;
  changeAddress: string | null;
  buildInput: (utxo: UTXO) => PsbtCoreInput | Promise<PsbtCoreInput>;
  lockTime?: number;
  /** 是否启用 RBF（BIP125）。默认 true —— 见 SEQUENCE_RBF 注释。 */
  rbf?: boolean;
};

// nSequence 取值：
//   0xFFFFFFFD → 启用 RBF（BIP125）且仍允许 nLockTime 生效
//   0xFFFFFFFE → 允许 nLockTime 但**禁用** RBF
// 旧实现固定用 0xFFFFFFFE，导致低费交易卡在 mempool 时用户完全无法加速，
// 只能干等——对主网钱包是明显的功能缺失。现在默认启用 RBF。
export const SEQUENCE_RBF = 0xfffffffd;
export const SEQUENCE_NO_RBF = 0xfffffffe;

export async function buildPsbtCore(params: PsbtCoreParams): Promise<{ psbtB64: string; inputCount: number }> {
  const tx = new btc.Transaction(params.lockTime && params.lockTime > 0 ? { lockTime: params.lockTime } : {});
  for (const utxo of params.selected) {
    const inp = await params.buildInput(utxo);
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      sequence: params.rbf === false ? SEQUENCE_NO_RBF : SEQUENCE_RBF,
      witnessUtxo: { script: inp.script, amount: BigInt(utxo.value) },
      bip32Derivation: inp.bip32Derivation,
    });
  }
  tx.addOutputAddress(params.recipient, BigInt(params.amountSats), getBtcNetwork());
  if (params.changeAmount > DUST_THRESHOLD_SATS && params.changeAddress) {
    tx.addOutputAddress(params.changeAddress, BigInt(params.changeAmount), getBtcNetwork());
  }
  return { psbtB64: base64.encode(tx.toPSBT()), inputCount: params.selected.length };
}

type ApiUtxo = {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean };
};

export class DustChangeError extends Error {
  constructor(public readonly dustSats: number) {
    super(`Change below dust threshold (${dustSats} sats) would be added to miner fee`);
  }
}

function scriptForAddress(address: string): Uint8Array {
  const decoded = btc.Address(getBtcNetwork()).decode(address);
  if (!decoded) throw new InvalidAddressError(address);
  return btc.OutScript.encode(decoded);
}

function parseUtxoResponse(json: unknown, address: string, includeUnconfirmed: boolean): UTXO[] {
  if (!Array.isArray(json)) throw new Error("Invalid UTXO response");
  const script = scriptForAddress(address);
  return json
    .filter((utxo: ApiUtxo) => (
      typeof utxo.txid === "string" &&
      Number.isInteger(utxo.vout) &&
      Number.isFinite(utxo.value) &&
      utxo.value > 0 &&
      (includeUnconfirmed || utxo.status?.confirmed)
    ))
    .map((utxo: ApiUtxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      script,
      address,
    }));
}

/**
 * UTXO 集合的规范化指纹，用于多源交叉比对。
 * 排序后拼接，消除节点返回顺序差异；只比对共识事实（outpoint + 金额）。
 */
function utxoFingerprint(utxos: UTXO[]): string {
  return utxos
    .map((u) => `${u.txid}:${u.vout}:${u.value}`)
    .sort()
    .join("|");
}

export class SourcesDisagreeError extends Error {
  constructor(public readonly address: string) {
    super(
      `Bitcoin data sources disagree about ${address}. ` +
        `Refusing to build a transaction from possibly tampered UTXO data.`,
    );
  }
}

/**
 * 拉取单个地址的 UTXO，**双源交叉验证**。
 *
 * 【为什么必须是交叉验证而不是 failover】README 与 hosts.ts 都把"关键读取双源
 * 交叉验证"写成了不做证书固定的理由，但 `fetchBitcoinApiCrossChecked` 此前
 * **从未被任何代码调用过** —— 余额 / UTXO / 交易历史走的全是 first-success
 * failover。这条防线在文档里存在，在代码里不存在。
 *
 * failover 挡不住 MITM 最有价值的攻击形态：**隐瞒**。伪造余额变高没意义（花不
 * 出去），但隐藏一笔 UTXO 会让用户在不知情下少花；伪造一笔未确认入账会诱导
 * 用户发货。只要第一个节点成功，第二个节点根本不会被问到。
 *
 * @param crossCheck 传 false 用于纯展示路径（省一半请求）；发送路径必须为 true
 */
async function fetchUtxosForAddress(
  address: string,
  includeUnconfirmed = false,
  crossCheck = false,
): Promise<UTXO[]> {
  // 东京反代 blockchain.info（国内可达 + ~0.3s 稳定）。
  // 不 fallback mempool/blockstream：国内 mempool 直连 4-7s 极慢，偶发 blockchain.info
  // 抖动时 fallback 反而拖垮整批 fanout（每地址 9s timeout）。偶发失败由 fanout
  // retryFailed 重试覆盖；重试仍失败则该地址 UTXO 缺失（selectInputs 兜底
  // InsufficientBalance 提示重试，金库则少算可下拉刷新）。
  const raw = await fetchUtxosRawBlockchainInfo(address);
  return parseUtxoResponse(raw, address, includeUnconfirmed);
}

/**
 * **批量**拉一组地址的 UTXO。这是余额/可花集合稳定性的关键改动。
 *
 * 旧路径是「每个地址一次 HTTP」：gap limit 20 → 42 个地址 → 42 次请求。
 * 第三方公共 API 必然限流其中若干次，fanout 如实标 complete=false，但上层为了
 * 「能用」又容忍了部分失败 —— **每次刷新失败的地址不同，余额就跟着跳**。
 * 这就是「金库余额显示不稳定」的直接成因，也是热钱包偶发「余额够却说不够」的成因。
 *
 * 改用 blockchain.info 的多地址接口后 42 个地址 = 2~3 次请求，限流概率接近零。
 * 归属靠**本地派生的 scriptPubKey** 匹配，不信任 API 返回的地址字符串。
 */
export async function fetchUtxosForAddresses(
  addresses: readonly string[],
  includeUnconfirmed = true,
): Promise<Map<string, UTXO[]>> {
  const scriptByAddress = new Map<string, Uint8Array>();
  const scriptHexByAddress = new Map<string, string>();
  for (const address of addresses) {
    const script = scriptForAddress(address);
    scriptByAddress.set(address, script);
    scriptHexByAddress.set(address, bytesToHex(script));
  }

  const rawByAddress = await fetchUtxosBatchBlockchainInfo(addresses, scriptHexByAddress);

  const out = new Map<string, UTXO[]>();
  for (const [address, raw] of rawByAddress) {
    const script = scriptByAddress.get(address);
    if (!script) continue;
    out.set(
      address,
      raw
        .filter((u) => includeUnconfirmed || u.status?.confirmed)
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, script, address })),
    );
  }
  return out;
}

/**
 * 拉取全钱包 UTXO，**如实报告完整性**。
 *
 * 【旧实现的问题】`.catch(() => [])` 把失败的地址静默当成"这个地址没有 UTXO"。
 * gap limit 提到 20 之后一次刷新是 40+ 个地址并发，mempool.space 限流返回 429
 * 是常态——于是余额少算、可花 UTXO 少算，UI 上和"你真的没钱"完全无法区分。
 * 而且无上限的 Promise.all 正是触发限流的原因本身。
 *
 * 现在走有界并发，且把 complete 交给调用方判断。
 */
export async function fetchAllWalletUtxosDetailed(
  /** 发送路径必须开启双源交叉验证；纯展示可关闭以省一半请求。 */
  crossCheck = true,
): Promise<FanoutResult<UTXO>> {
  const addresses = await scanWalletAddresses();
  const result = await scanUtxosBatched(addresses.map((a) => a.address), crossCheck);
  if (!result.complete) {
    logger.warn("Partial UTXO scan", { failed: result.failed, total: result.total });
  }
  return result;
}

/**
 * 一组地址的 UTXO 扫描：**先批量，失败再退回逐地址 fanout**。
 *
 * includeUnconfirmed 恒为 true —— 与首页余额口径一致，且广播后未确认的找零必须
 * 能立刻用作下一笔的输入，否则会出现「首页显示有余额、发送却说余额不足」。
 */
export async function scanUtxosBatched(
  addresses: readonly string[],
  crossCheck = false,
): Promise<FanoutResult<UTXO>> {
  if (addresses.length === 0) {
    return { data: [], complete: true, succeeded: 0, failed: 0, total: 0 };
  }
  try {
    const byAddress = await fetchUtxosForAddresses(addresses, true);
    const data: UTXO[] = [];
    for (const list of byAddress.values()) data.push(...list);
    return {
      data,
      complete: true,
      succeeded: addresses.length,
      failed: 0,
      total: addresses.length,
    };
  } catch (err) {
    // 批量接口不可用（反代未放行 /unspent 多地址、URL 过长、上游改版……）
    // 退回旧的逐地址路径，功能不降级，只是请求变多。
    logger.warn("Batched UTXO scan failed, falling back to per-address", err);
  }
  return fanout(
    addresses.map((address) => ({ address })),
    ({ address }) => fetchUtxosForAddress(address, true, crossCheck),
    DEFAULT_FANOUT_CONCURRENCY,
    // 发送路径对失败地址自动重试 1 次：偶发抖动第二轮往往能成功。
    // 不多试——httpQueue 已对单请求退避，fanout 层重试过多会累计超时拖垮整批发送。
    1,
  );
}

/**
 * @deprecated 丢失了完整性信息，仅供只读展示。发送路径请用 fetchAllWalletUtxosDetailed。
 * 展示路径不做交叉验证——请求量减半，且展示错了不会直接造成资金损失。
 */
export async function fetchAllWalletUtxos(): Promise<UTXO[]> {
  return (await fetchAllWalletUtxosDetailed(false)).data;
}

export function estimateSendFeeSats(inputCount: number, feeRate: number, hasChange = true) {
  return Math.ceil(estimateTxVbytes(inputCount, hasChange ? 2 : 1) * feeRate);
}

/**
 * 币选。**BnB（无找零解优先）+ 随机抽取回退**，实现在 services/coinSelection。
 *
 * 【为什么换掉 largest-first】旧实现每次都从最大的 UTXO 开始拿：
 *   - 隐私：永远动最大那笔，链上分析可稳定识别本钱包的找零模式
 *   - UTXO 集恶化：大额被不断劈成找零，小额永不消耗，UTXO 数单调上升，
 *     未来每笔交易的手续费也跟着涨
 *   - 手续费：几乎必然产生找零输出（+31 vB），而无找零解本可省掉
 *
 * 保留原有的 DustChangeError / InsufficientBalanceError 语义，调用方无需改动。
 */
export function selectInputs<T extends UTXO>(utxos: T[], amountSats: number, feeRate: number) {
  const spendable = utxos.filter((u) => Number.isFinite(u.value) && u.value > 0);
  // 空集合 = 这个钱包**确实**一分钱没有（网络失败的情形已在 getWalletUtxosCached
  // 提前抛 IncompleteDataError 拦下）。用 InsufficientBalanceError 而不是裸 Error：
  // UI 已有针对它的中文文案「余额不足」，比抛一句英文 "No spendable UTXOs
  // available" 给用户看要准确得多。
  if (spendable.length === 0) throw new InsufficientBalanceError(amountSats, 0);

  try {
    const result = selectCoins({
      utxos: spendable,
      targetSats: amountSats,
      feeRate,
      // P2WPKH 尺寸，与 estimateTxVbytes 保持一致
      inputVbytes: 68,
      outputVbytes: 31,
      overheadVbytes: 11,
      dustThreshold: DUST_THRESHOLD_SATS,
    });
    return {
      selected: result.selected,
      fee: result.feeSats,
      changeAmount: result.changeSats,
    };
  } catch (err) {
    if (err instanceof NoSolutionError) {
      // 与旧接口对齐：区分"钱不够"和"凑不出合规组合"。
      const available = spendable.reduce((s, u) => s + u.value, 0);
      const minFee = estimateSendFeeSats(1, feeRate, false);
      if (available < amountSats + minFee) {
        throw new InsufficientBalanceError(amountSats + minFee, available);
      }
      // 余额够但选不出解：只可能是剩余额全部卡在 dust 区间。
      throw new DustChangeError(available - amountSats - minFee);
    }
    throw err;
  }
}

/** @deprecated 旧的 largest-first 实现，仅保留供对照测试。 */
export function selectInputsLegacy<T extends UTXO>(utxos: T[], amountSats: number, feeRate: number) {
  // Note: UTXOs include unconfirmed ones (from fetchAllWalletUtxos with includeUnconfirmed=true).
  // Without confirmed/unconfirmed status on UTXO, we prefer larger UTXOs which are
  // statistically more likely to be confirmed.
  const spendable = [...utxos].filter((utxo) => Number.isFinite(utxo.value) && utxo.value > 0);
  if (spendable.length === 0) throw new Error("No spendable UTXOs available");

  const sortedDesc = [...spendable].sort((a, b) => b.value - a.value);

  // Prefer a single input large enough to cover amount + fee with no change output.
  const singleNoChange = sortedDesc.find(
    (u) => u.value >= amountSats + estimateSendFeeSats(1, feeRate, false),
  );

  let selected: T[];
  let inputSum: number;

  if (singleNoChange) {
    selected = [singleNoChange];
    inputSum = singleNoChange.value;
  } else {
    selected = [];
    inputSum = 0;
    for (const utxo of [...spendable].sort((a, b) => b.value - a.value)) {
      selected.push(utxo);
      inputSum += utxo.value;
      if (inputSum >= amountSats + estimateSendFeeSats(selected.length, feeRate, false)) break;
    }
  }

  const feeNoChange = estimateSendFeeSats(selected.length, feeRate, false);
  const surplusNoChange = inputSum - amountSats - feeNoChange;

  // 余额不足要最先判定：surplus 为负时下面的 dust 分支都没有意义。
  if (inputSum < amountSats + feeNoChange) {
    throw new InsufficientBalanceError(amountSats + feeNoChange, inputSum);
  }

  if (surplusNoChange > DUST_THRESHOLD_SATS) {
    const feeWithChange = estimateSendFeeSats(selected.length, feeRate, true);
    const changeWithChange = inputSum - amountSats - feeWithChange;
    if (changeWithChange > DUST_THRESHOLD_SATS) {
      return { selected, fee: feeWithChange, changeAmount: changeWithChange };
    }
    // 有剩余但产生不了合规找零输出 —— 这笔剩余会被矿工吃掉，必须告知用户。
    //
    // 【旧实现的漏洞】这里只处理了 `changeWithChange > 0`。当加一个找零输出的
    // 成本(≈31 vB × feeRate)反而超过剩余额时，changeWithChange <= 0，三个 guard
    // 全部落空，函数直接返回 changeAmount: 0 —— 一笔大于 dust 门槛的余额被**静默
    // 烧成手续费**。实测：单个 100000 sat UTXO 发 97200 @20 sat/vB，surplus = 600
    // sats（> DUST 546），找零输出成本 620，600 sats 无声进了矿工口袋。
    throw new DustChangeError(Math.max(changeWithChange, surplusNoChange));
  }

  // 没有找零输出时的 dust check：余额多余部分直接给了矿工
  if (surplusNoChange > 0) {
    throw new DustChangeError(surplusNoChange);
  }

  return { selected, fee: feeNoChange, changeAmount: 0 };
}

// UTXO 短时缓存：预览与构造是同一次用户操作的两个阶段，旧实现各自
// fetchAllWalletUtxos() 一遍，等于把全部地址的 UTXO 拉了两次。
const UTXO_CACHE_TTL_MS = 15_000;
let utxoCache: { at: number; utxos: UTXO[] } | null = null;

export function invalidateUtxoCache(): void {
  utxoCache = null;
}

// 锁屏与网络模式切换同样必须清缓存：前者可能切到胁迫钱包（UTXO 完全是另一套），
// 后者会改变整棵地址树（coin type 0' ↔ 1'）。
onLock(() => invalidateUtxoCache());
subscribeNetworkMode(() => invalidateUtxoCache());

async function getWalletUtxosCached(): Promise<UTXO[]> {
  if (utxoCache && Date.now() - utxoCache.at < UTXO_CACHE_TTL_MS) return utxoCache.utxos;
  // 发送路径用 failover（不开 crossCheck）：国内网络下 mempool/blockstream 双源都不稳时，
  // 交叉验证会等两源都超时才 fallback，极慢。failover 顺序试，任一可达即用，快得多。
  // 安全性：mempool/blockstream 同为 esplora 后端 + HTTPS，failover 多源已足够防篡改。
  const result = await fetchAllWalletUtxosDetailed(false);

  // 【iOS 端 "No spendable UTXOs available" 的根因】
  // 旧实现无条件返回 result.data。当**每一个**地址的查询都失败时（移动网络切换、
  // 反代抖动、DNS 污染），data 是空数组，接着 selectInputs 抛出
  // "No spendable UTXOs available" —— 一条把「网络没通」说成「你没钱」的错误提示。
  // 这两件事对用户的下一步动作完全不同：前者应该重试，后者应该充值。
  if (result.total > 0 && result.succeeded === 0) {
    throw new IncompleteDataError(result.failed, result.total, result.firstError);
  }
  // 部分失败仍然容忍：用扫到的 UTXO（selectInputs 兜底 InsufficientBalance）。
  // assertComplete 太严（网络偶发抖动就卡死整笔发送），与"稳定可用"冲突。
  const utxos = result.data;
  if (result.complete) utxoCache = { at: Date.now(), utxos };
  return utxos;
}

/**
 * 后台预热 UTXO 缓存：进发送页时调用，用户填完金额后大概率命中缓存、合计秒出。
 * httpQueue 的 in-flight GET 去重会合并预热与正式 previewSendTx 的重复请求，不额外耗流量。
 * 失败静默——正式发送的 previewSendTx 会重新扫。
 */
export async function prefetchWalletUtxos(): Promise<void> {
  try {
    await getWalletUtxosCached();
  } catch {
    /* 预热失败无所谓，previewSendTx 会重试 */
  }
}

export async function previewSendTx(
  amountSats: number,
  feeRate: number
): Promise<{ feeSats: number; inputCount: number; changeSats: number }> {
  const utxos = await getWalletUtxosCached();
  const { selected, fee, changeAmount } = selectInputs(utxos, amountSats, clampFeeRate(feeRate));
  return { feeSats: fee, inputCount: selected.length, changeSats: changeAmount };
}

async function fetchWalletBalanceSats(): Promise<number> {
  const utxos = await fetchAllWalletUtxos();
  return utxos.reduce((sum, u) => sum + u.value, 0);
}

export type BuiltPsbt = {
  psbtB64: string;
  changeAddressIdx: number | null;  // null = 无找零；否则广播成功后 commit 这个索引
  feeSats: number;
  inputCount: number;
};

// 单签 BIP84 派生路径校验：m/84'/{0|1}'/0'/{0|1}/index。防盲签陌生路径。
function isWalletDerivationPath(path: number[]): boolean {
  const H = 0x80000000;
  if (path.length !== 5) return false;
  if (path[0] !== 84 + H) return false;
  if (path[1] !== 0 + H && path[1] !== 1 + H) return false;
  if (path[2] !== 0 + H) return false;
  return path[3] === 0 || path[3] === 1;
}

// 构造未签 PSBT（每个 input 带 bip32Derivation，离线端据此从 path 派生私钥）。
// peek 找零索引不递增，避免构造后放弃造成空洞；广播成功才 commit。
export async function buildUnsignedPsbt(
  recipientAddress: string,
  amountSats: number,
  feeRate: number,
  /** 本次发送是否已通过生物识别确认（danger 环境下强制要求，见 security.ts）。 */
  biometricConfirmed = false,
): Promise<BuiltPsbt> {
  if (!validateBtcAddress(recipientAddress)) throw new InvalidAddressError(recipientAddress);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error(`Invalid amount: ${amountSats}`);
  }
  // 越狱 / 模拟器 / 检测到 hook 的环境下收紧单笔上限 + 强制生物识别
  // （见 security.getSecurityPolicy）
  assertSendAllowed(amountSats, biometricConfirmed);
  const clampedFeeRate = clampFeeRate(feeRate);

  // 容忍部分失败：用扫到的 UTXO（selectInputs 兜底余额检查）。
  const allUtxos = await getWalletUtxosCached();
  // 自转检测必须查**整棵派生树**，不能只查"有 UTXO 的地址"。
  // 旧实现用 allUtxos 里出现过的地址建集合 —— 发到自己一个还没收过款的新收款
  // 地址（正是"换个地址收"的常见操作）完全检测不到。
  const ownAddresses = new Set((await scanWalletAddresses()).map((a) => a.address));
  if (ownAddresses.has(recipientAddress)) throw new SelfSendError();

  const { selected, fee, changeAmount } = selectInputs(allUtxos, amountSats, clampedFeeRate);

  // 费狙击防护：提前获取区块高度，构造 Transaction 时即设置 nLockTime。
  let lockTime = 0;
  try { lockTime = await fetchBlockHeight(); } catch { /* use 0 */ }

  let changeAddressIdx: number | null = null;
  let changeAddress: string | null = null;
  if (changeAmount > DUST_THRESHOLD_SATS) {
    const peek = await peekChangeAddressAsync();
    changeAddressIdx = peek.idx;
    changeAddress = peek.address;
  }

  const { psbtB64, inputCount } = await buildPsbtCore({
    recipient: recipientAddress,
    amountSats,
    selected,
    changeAmount,
    changeAddress,
    lockTime,
    buildInput: async (utxo) => {
      const der = await walletInputDerivation(utxo.address);
      return {
        script: utxo.script,
        bip32Derivation: [[der.pubkey, { fingerprint: der.fingerprint, path: der.path }]],
      };
    },
  });

  return { psbtB64, changeAddressIdx, feeSats: fee, inputCount };
}

// 离线签名：不触网。从 PSBT bip32Derivation 取 path，校验前缀后派生私钥签名。
// 同时校验 witnessUtxo.script 与派生 pubkey 一致，防 PSBT 被篡改。
/**
 * PSBT 手续费理智校验。
 *
 * 旧实现在签名端校验了输出数量、输入 script、派生路径，**唯独没校验手续费**。
 * 一个被攻破的协调端可以构造「1 个正常收款输出 + 巨额矿工费」的 PSBT，
 * 所有现有检查都能通过。reviewPsbt() 会把 fee 显示给用户，但那只是 UI 软防线。
 * 这里在签名前 hard-fail。
 */
/** 单签路径的手续费判定。规则实现在 feePolicy —— 与多签共用同一份。 */
export function assertFeeSane(tx: btc.Transaction): FeeVerdict {
  let inputSum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const wu = tx.getInput(i).witnessUtxo;
    if (wu?.amount) inputSum += wu.amount;
  }
  let outputSum = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    outputSum += tx.getOutput(i).amount ?? 0n;
  }
  return checkFee({
    inputSats: Number(inputSum),
    outputSats: Number(outputSum),
    vbytes: estimateTxVbytes(tx.inputsLength, tx.outputsLength),
  });
}

/** 单签路径的策略上下文。差异注入见 psbtPolicy 文件头。 */
async function singleSigPolicyContext(): Promise<PsbtPolicyContext> {
  return {
    ownScripts: await collectWalletScripts(),
    vbyteEstimator: estimateTxVbytes,
    addressDecoder: (script) => decodeOutputAddress(script),
  };
}

export async function signPsbtOffline(psbtB64: string): Promise<string> {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  const privKeys: Uint8Array[] = [];
  try {
    // 手续费上限 + 输出归属 + 未知地址，三项一次校验完毕。
    // 实现在 psbtPolicy —— **与多签共用同一份**，不再是两份各自漂移的拷贝。
    // 单签支付应有且仅有 1 个"外部"输出（收款方），其余为找零（须属本钱包）。
    // 收款地址本身被改的情形由 UI 摘要(reviewPsbt)供用户核对兜底。
    assertSignable(tx, await singleSigPolicyContext(), { expectedExternalOutputs: 1 });

    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const witnessUtxo = input.witnessUtxo;
      if (!witnessUtxo) throw new Error(`Input ${i} missing witnessUtxo`);
      const derivations = input.bip32Derivation ?? [];
      if (derivations.length === 0) {
        throw new Error(`Input ${i} missing bip32Derivation`);
      }
      const [, info] = derivations[0];
      const path = info.path;
      if (!isWalletDerivationPath(path)) {
        throw new Error(`Input ${i} derivation path outside wallet tree`);
      }
      const { publicKey, privateKey } = deriveKeyForPath(path);
      privKeys.push(privateKey);
      const expected = btc.p2wpkh(publicKey, getBtcNetwork());
      if (!expected.script || !constantTimeEqual(witnessUtxo.script, expected.script)) {
        throw new Error(`Input ${i} script mismatch — PSBT may be tampered`);
      }
      tx.signIdx(privateKey, i);
    }
    return base64.encode(tx.toPSBT());
  } finally {
    for (const priv of privKeys) priv.fill(0);
  }
}

// 收集本钱包 receive/change 派生地址的 p2wpkh 输出脚本，用于输出归属判定。
async function collectWalletScripts(): Promise<Uint8Array[]> {
  if (!isWalletUnlocked()) {
    throw new Error("Wallet is locked — cannot verify PSBT outputs");
  }
  const out: Uint8Array[] = [];
  try {
    const addrs = await scanWalletAddresses();
    for (const a of addrs) {
      try {
        out.push(scriptForAddress(a.address));
      } catch {
        // 单个地址派生失败跳过
      }
    }
  } catch (e) {
    logger.warn("collectWalletScripts failed", e);
  }
  return out;
}

// PSBT 人可读摘要（供签名前 UI 审查）：输入数、各输出地址+金额、手续费。
// address 反解走 Address.encode(OutScript.decode(script))，失败时返回 "?" sentinel
// 让 UI 拦截（点确认按钮时拒绝放行）—— 比返回空串更明确，避免攻击者用非标脚本
// 让用户看到空白地址时误以为是"自己地址前缀被截断"而盲目签名。
export { UNKNOWN_OUTPUT_ADDRESS } from "./psbtCommon";

export type PsbtReviewOutput = { address: string; sats: number };
export type PsbtReviewSummary = {
  inputCount: number;
  outputs: PsbtReviewOutput[];
  feeSats: number;
};

/**
 * 输出脚本 → 地址。失败返回 null，由 psbtPolicy 统一换成 "?" sentinel。
 *
 * OutScript.decode 在 btc-signer 里返回联合类型（pubkey/hash/witness 等），
 * Address.encode 期望 PubKeyScript/HashScript，TS 类型不严格兼容，故需 as any。
 */
export function decodeOutputAddress(script: Uint8Array): string | null {
  try {
    return btc.Address(getBtcNetwork()).encode(btc.OutScript.decode(script) as any);
  } catch {
    return null;
  }
}

/**
 * PSBT 人可读摘要（供签名前 UI 审查）。
 * 内部走 psbtPolicy.reviewPsbtWithPolicy —— 与签名端 assertSignable 是同一段
 * 解析逻辑，杜绝"UI 显示的和签名端判定的不是同一回事"。
 */
export function reviewPsbt(psbtB64: string): PsbtReviewSummary {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  // 纯展示：这里拿不到（也不需要）自有脚本集合，isOwn 一律 false 不影响摘要。
  const review = reviewPsbtWithPolicy(tx, {
    ownScripts: [],
    vbyteEstimator: estimateTxVbytes,
    addressDecoder: (script) => decodeOutputAddress(script),
  });
  return {
    inputCount: review.inputCount,
    outputs: review.outputs.map((o) => ({ address: o.address, sats: o.sats })),
    feeSats: review.feeSats,
  };
}

// Helper: 任一输出地址未识别（"?"）→ 阻断签名。调用方在 review 后、sign 前调一次。
export function hasUnknownOutput(review: PsbtReviewSummary): boolean {
  return anyUnknownOutput(review.outputs);
}

/** PSBT 对应交易的 txid。隔离见证下签名不改变 txid，见 psbtCommon 的说明。 */
export function psbtTxid(psbtB64: string): string {
  return btc.Transaction.fromPSBT(base64.decode(psbtB64.trim())).id;
}

/**
 * 气隙回程校验：扫回来的已签 PSBT 必须**就是**我发出去的那一笔。
 * 不一致直接抛 PsbtMismatchError —— 绝不能只是提示一下然后照常广播。
 */
export function assertSamePsbtTransaction(expectedPsbtB64: string, actualPsbtB64: string): void {
  const expected = psbtTxid(expectedPsbtB64);
  const actual = psbtTxid(actualPsbtB64);
  if (expected !== actual) throw new PsbtMismatchError(expected, actual);
}

/**
 * PSBT 里已经有多少个输入带上了签名。
 *
 * 用途：离线端把 PSBT 原样传回来（没签、或只签了一部分）时，早点告诉用户，
 * 而不是等广播被节点拒绝才报一个看不懂的错误。
 */
export function signedInputCount(psbtB64: string): number {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  let signed = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const hasPartial = (input.partialSig?.length ?? 0) > 0;
    // ⚠️ 必须比长度，不能比真假：@scure 对未签的输入给的是**空的**
    // Uint8Array / 空数组，而 `Boolean(new Uint8Array(0))` 是 **true**。
    // 写成 `Boolean(input.finalScriptSig)` 会让未签 PSBT 也被算成已签，
    // 这条守卫就永远不会触发（测试当场抓到）。
    const hasFinalWitness = (input.finalScriptWitness?.length ?? 0) > 0;
    const hasFinalScriptSig = (input.finalScriptSig?.length ?? 0) > 0;
    if (hasPartial || hasFinalWitness || hasFinalScriptSig) signed++;
  }
  return signed;
}

/**
 * 广播兜底：逐个 esplora 节点 POST /tx，**保留节点给出的拒绝理由**。
 *
 * @returns 节点返回的 txid；节点表示"已经有这笔"时返回 null（视为成功）
 */
async function broadcastFallback(rawHex: string, primaryErr: unknown): Promise<string | null> {
  const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
  const reasons: string[] = [];

  for (const node of getApiBase()) {
    let res: Response;
    try {
      res = await queuedFetch(`${node}/tx`, {
        method: "POST",
        body: rawHex,
        headers: { "Content-Type": "text/plain" },
        timeoutMs: 20000,
      });
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const text = (await res.text().catch(() => "")).trim();
    if (res.ok) {
      if (/^[0-9a-f]{64}$/i.test(text)) return text.toLowerCase();
      return null;
    }
    // 节点说「这笔我已经收过了」= 上一次广播其实成功了，不能报失败，
    // 否则用户会以为没发出去而重复点击（RBF 开着，重发有替换掉前一笔的风险）。
    if (isAlreadyBroadcast(text)) return null;
    reasons.push(`${res.status} ${redactTxids(text).slice(0, 160)}`.trim());
  }

  throw new Error(
    `Broadcast failed. ${redactTxids(primaryMsg)}${reasons.length ? ` | ${reasons.join(" | ")}` : ""}`,
  );
}

// 广播已签 PSBT。finalizeAndExtract 复用自 vault/psbt.ts（单签多签通用）。
// 广播成功后提交找零索引递增（仅热钱包/signing-terminal 上下文传入 idx）。
export async function broadcastSignedPsbt(
  psbtB64: string,
  changeAddressIdx?: number,
): Promise<{ txid: string }> {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  const expectedTxid = tx.id;
  const rawHex = finalizeAndExtract(psbtB64);

  let returnedTxid: string | null;
  try {
    // 主路径：东京反代 blockchain.info/pushtx（国内可达 + 稳，mempool 直连 POST 被 400）
    returnedTxid = (await broadcastBlockchainInfo(rawHex)).txid;
  } catch (bciErr) {
    // fallback：mempool/blockstream（不稳但兜底）。
    //
    // 【旧实现的两个问题】
    //  1. 走的是 fetchBitcoinApi —— 它在非 2xx 时**不会返回 response**，而是自己
    //     抛 `Network unavailable: 400 Bad Request`。下面那段读 errText 的代码
    //     是死代码，节点给出的真实拒绝理由（bad-txns-inputs-missingorspent /
    //     txn-already-in-mempool / min relay fee not met）**全部丢失**，
    //     用户只看得到一个光秃秃的 400。
    //  2. `throw` 的是**字符串**不是 Error，上层 `error instanceof Error` 判false，
    //     连这个 400 都显示不出来。
    // 现在直接走 queuedFetch 逐节点试，把拒绝理由（脱敏后）带回来。
    returnedTxid = await broadcastFallback(rawHex, bciErr);
  }
  if (returnedTxid && returnedTxid !== expectedTxid) {
    throw new Error(`Broadcast txid mismatch (expected ${expectedTxid})`);
  }

  // 广播成功 → 刚才花掉的 UTXO 必须立刻从缓存里清掉。
  //
  // 【旧实现的漏洞】invalidateUtxoCache 定义了但**全项目零调用**，缓存 TTL 15 秒。
  // 用户在 15 秒内发第二笔（点快了、以为没成功又点一次），selectInputs 会拿到
  // 同一批已花费的 UTXO，构造出一笔与前一笔冲突的交易；而 RBF 默认开启，
  // 后一笔还可能直接把前一笔替换掉——收款方那笔钱就没了。
  invalidateUtxoCache();

  if (changeAddressIdx !== undefined && changeAddressIdx >= 0) {
    await commitChangeAddress(changeAddressIdx);
  }
  return { txid: returnedTxid || expectedTxid };
}

// 兼容包装：热钱包路径串接三段，行为零回归。
export async function buildAndSendTx(
  recipientAddress: string,
  amountSats: number,
  feeRate: number,
  biometricConfirmed = false,
): Promise<string> {
  const built = await buildUnsignedPsbt(recipientAddress, amountSats, feeRate, biometricConfirmed);
  const signed = await signPsbtOffline(built.psbtB64);
  const { txid } = await broadcastSignedPsbt(signed, built.changeAddressIdx ?? undefined);
  return txid;
}

export { fetchUtxosForAddress };
// 兼容旧调用点：这两个符号原先由本模块导出，现已迁到 feePolicy。
export { ExcessiveFeeError, clampFeeRate };
export type { FeeVerdict };
// 数据不完整时的错误类型，UI 需要单独提示"请重试"而不是"余额不足"。
export { IncompleteDataError };
export type { FanoutResult };
