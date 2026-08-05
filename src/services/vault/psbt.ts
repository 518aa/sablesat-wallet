import { HDKey } from "@scure/bip32";
import { base64 } from "@scure/base";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { cosignerInputDerivation, derivationToChangeIndex, deriveSelfPrivateKeyAt } from "./cosigner";
import { deriveVaultAddress } from "./multisig";
import { getBtcNetwork } from "../network-mode";
import { parseExtKey } from "../extkey";
import { bytesToHex, constantTimeEqual } from "../crypto";
import { DUST_THRESHOLD_SATS } from "../../utils/bitcoin";
import { clampFeeRate } from "../feePolicy";
import { anyUnknownOutput } from "../psbtCommon";
import { assertSignable, reviewPsbtWithPolicy, type PsbtPolicyContext } from "../psbtPolicy";
import type { PsbtSummary, VaultConfig, VaultUtxo } from "./types";

type Recipient = { address: string; sats: number };

type BuildParams = {
  vault: VaultConfig;
  inputs: VaultUtxo[];
  recipients: Recipient[];
  changeIsChange: boolean;
  changeIndex: number;
  feeRate: number;
  lockTime?: number; // 费狙击防护：nLockTime 区块高度（0 表示未设置）
  /** 是否启用 RBF（BIP125）。默认 true。 */
  rbf?: boolean;
  /**
   * 允许把「建不出合规找零」的零头计入矿工费。
   * 仅在 UI 已把具体金额告知用户并取得确认后才传 true。
   */
  acceptDustToFee?: boolean;
};

/**
 * 剩余金额高于 dust、本可建找零，但建找零输出不划算 —— 这笔钱会进矿工口袋。
 * 金额可感知，必须由用户拍板，不静默烧掉，也不无条件阻断。
 */
export class VaultDustChangeError extends Error {
  constructor(public readonly dustSats: number) {
    super(`Change below dust threshold: ${dustSats} sats would go to the miner`);
    this.name = "VaultDustChangeError";
  }
}

type DerivationInfo = {
  isChange: boolean;
  index: number;
  witnessScript: Uint8Array;
  script: Uint8Array;
  address: string;
};

function buildDerivationMap(vault: VaultConfig, inputs: VaultUtxo[]): Map<string, DerivationInfo> {
  const map = new Map<string, DerivationInfo>();
  for (const u of inputs) {
    const derived = deriveVaultAddress(vault.cosigners, u.isChange, u.derivationIndex, vault.m);
    map.set(`${u.txid}:${u.vout}`, {
      isChange: u.isChange,
      index: u.derivationIndex,
      witnessScript: derived.witnessScript,
      script: derived.script,
      address: derived.address,
    });
  }
  return map;
}

export function buildVaultPsbt(params: BuildParams): string {
  const { vault, inputs, recipients, changeIsChange, changeIndex, feeRate } = params;
  if (inputs.length === 0) throw new Error("No inputs selected");
  if (recipients.length === 0) throw new Error("No recipients");

  // 费狙击防护：nLockTime 设为当前区块高度（如果有提供），防矿工重挖窃取手续费。
  const lockTime = params.lockTime ?? 0;
  const tx = new Transaction(lockTime > 0 ? { lockTime } : {});
  const derivations = buildDerivationMap(vault, inputs);

  let inputSum = 0;
  for (const u of inputs) {
    const d = derivations.get(`${u.txid}:${u.vout}`);
    if (!d) throw new Error(`Missing derivation for input ${u.txid}:${u.vout}`);
    const bip32Derivation = vault.cosigners.map((c) => {
      const der = cosignerInputDerivation(c, u.isChange, u.derivationIndex);
      return [der.pubkey, { fingerprint: der.fingerprint, path: der.path }] as [
        Uint8Array,
        { fingerprint: number; path: number[] },
      ];
    });
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: params.rbf === false ? 0xfffffffe : 0xfffffffd,
      witnessUtxo: { script: d.script, amount: BigInt(u.value) },
      witnessScript: d.witnessScript,
      bip32Derivation,
    });
    inputSum += u.value;
  }

  let outputSum = 0;
  for (const r of recipients) {
    tx.addOutputAddress(r.address, BigInt(r.sats), getBtcNetwork());
    outputSum += r.sats;
  }

  // 费率钳制**与单签共用同一个 clampFeeRate**（[1, 500]）。
  // 旧实现这里钳到 5000，而签名端 assertVaultFeeSane 拒绝 >500 sat/vB ——
  // 用 600 造出来的 PSBT 自己的签名端直接拒签，用户拿到一笔造得出来签不动的交易。
  const clampedFeeRate = clampFeeRate(feeRate);

  // 先按"有找零"估费；若剩余不足以产生合规找零，退回"无找零"重算一次。
  //
  // 【旧实现缺失 send-max】恒定按 recipients.length + 1 估费，changeAmount <= 0
  // 直接抛 Insufficient funds —— 意味着**多签金库永远无法清仓**：想把余额全部
  // 转走时，总会因为多算了一个找零输出的费用而报余额不足。
  const feeWithChange = Math.ceil(
    estimateMultisigVbytes(inputs.length, recipients.length + 1, vault.m, vault.n) * clampedFeeRate,
  );
  const feeNoChange = Math.ceil(
    estimateMultisigVbytes(inputs.length, recipients.length, vault.m, vault.n) * clampedFeeRate,
  );

  const plan = planVaultChange({
    inputSum,
    outputSum,
    feeWithChange,
    feeNoChange,
    acceptDustToFee: params.acceptDustToFee === true,
  });

  if (plan.kind === "change") {
    const changeDerived = deriveVaultAddress(vault.cosigners, changeIsChange, changeIndex, vault.m);
    tx.addOutputAddress(changeDerived.address, BigInt(plan.changeSats), getBtcNetwork());
  }

  return base64.encode(tx.toPSBT());
}

export type VaultChangePlan =
  | { kind: "change"; changeSats: number; feeSats: number; dustToFeeSats: 0 }
  | { kind: "no-change"; changeSats: 0; feeSats: number; dustToFeeSats: number };

/**
 * 找零决策。**纯函数**，与 PSBT 构造分离，便于直接断言金额边界。
 *
 * 【旧实现把金库彻底卡死】只要 surplus > 0 就无条件抛
 * `Change below dust threshold: N sats`，**哪怕 N 只有 92 sats**。
 *
 * 但 92 sats 根本**不可能**变成一个输出：低于 546 的输出是 dust，中继节点直接
 * 拒绝。比特币的规则是「输入里没分配给输出的部分就是矿工费」—— 除了计入手续费
 * 之外没有第二种合法处理方式。旧代码等于因为一个几毛钱的零头，把整笔转账变成
 * 一条用户无论怎么调金额都可能再次撞上的死错误。
 *
 * 按金额分级：
 *   - surplus ≤ dust(546)：唯一合法选择就是计入手续费，直接放行。这与单签路径
 *     一致 —— selectCoins 的 BnB 本就把 costOfChange 窗口内的零头留给矿工。
 *   - surplus > dust：本可以建找零，只是建了不划算（建输出的成本 + 将来花掉它
 *     的成本 > 它本身）。金额可感知，必须由用户拍板，不静默烧掉。
 */
export function planVaultChange(p: {
  inputSum: number;
  outputSum: number;
  feeWithChange: number;
  feeNoChange: number;
  acceptDustToFee: boolean;
  dustThreshold?: number;
}): VaultChangePlan {
  const dust = p.dustThreshold ?? DUST_THRESHOLD_SATS;
  const changeAmount = p.inputSum - p.outputSum - p.feeWithChange;
  if (changeAmount > dust) {
    return { kind: "change", changeSats: changeAmount, feeSats: p.feeWithChange, dustToFeeSats: 0 };
  }
  const surplus = p.inputSum - p.outputSum - p.feeNoChange;
  if (surplus < 0) throw new Error(`Insufficient funds: short ${-surplus} sats`);
  if (surplus > dust && !p.acceptDustToFee) throw new VaultDustChangeError(surplus);
  return {
    kind: "no-change",
    changeSats: 0,
    feeSats: p.feeNoChange + surplus,
    dustToFeeSats: surplus,
  };
}

// 多签 vault 在 PSBT 输出归属判定时需要看的脚本集合范围。
//
// 【旧实现是一堵硬墙】固定 SIGN_GAP_LIMIT = 20：找零索引一旦超过 20，找零输出
// 就不在脚本集合里 → 被判为 external → `externalOutputs !== 1` → **签名直接拒绝，
// 金库里的钱再也花不出去**。注释里自己写着"多签用户实际找零索引可达 10+"，
// 说明 20 只是拍的一个数，而它的失败模式是资金永久冻结。
//
// 现在窗口从**已知的实际最高索引**往外扩，而不是从 0 起数固定 20 个：
//   window = max(已知最高 receive/change 索引, 0) + SIGN_GAP_MARGIN
// 已知索引来自调用方传入的 inputs（这些 UTXO 的索引是链上事实），因此窗口会
// 随金库使用自然生长，不存在"用到第 21 笔就砖了"这回事。
const SIGN_GAP_MARGIN = 20;
/** 单次派生的绝对上限，防御畸形 PSBT 声称一个超大索引导致派生几万个地址。 */
const SIGN_SCAN_HARD_CAP = 500;

function signScanUpperBound(knownIndices: number[]): number {
  const maxKnown = knownIndices.reduce((m, i) => (Number.isInteger(i) && i > m ? i : m), 0);
  return Math.min(maxKnown + SIGN_GAP_MARGIN, SIGN_SCAN_HARD_CAP);
}

/**
 * 多签 PSBT 手续费理智校验。与单签路径同一逻辑（transaction.assertFeeSane）。
 * 多签场景下 PSBT 来自其他设备，风险更高——旧实现校验了输出归属，但没校验 fee，
 * 一个被攻破的协调端可以构造「正常收款输出 + 巨额矿工费」通过全部现有检查。
 */
/** @deprecated 保留导出以兼容旧 catch 分支；实际抛出的是 feePolicy.ExcessiveFeeError。 */
export class ExcessiveVaultFeeError extends Error {
  constructor(feeSats: number, inputSum: number) {
    super(`Fee ${feeSats} sats exceeds sanity limit for input total ${inputSum} sats`);
  }
}

/**
 * 多签路径的策略上下文。与单签的区别只有三处注入项：
 * P2WSH 的 vbytes 估算、vault 协签方派生出的脚本集合、地址反解方式。
 * 判定规则本身在 psbtPolicy，只写一遍。
 */
function vaultPolicyContext(
  vault: VaultConfig,
  scanUpper: number,
  tx: Transaction,
): PsbtPolicyContext {
  return {
    ownScripts: collectVaultScripts(vault, scanUpper),
    vbyteEstimator: (i, o) => estimateMultisigVbytes(i, o, vault.m, vault.n),
    // 闭包捕获 tx，不用模块级可变量 —— 后者在并发调用（同时审查两笔 PSBT）
    // 下会串味，而且是那种只在真机上偶发、本地永远复现不出来的 bug。
    addressDecoder: (_script, index) => tx.getOutputAddress(index, getBtcNetwork()) ?? null,
  };
}

export function signVaultPsbtSelf(
  psbtB64: string,
  vault: VaultConfig,
  inputs: VaultUtxo[],
  root: HDKey,
): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  const derivations = buildDerivationMap(vault, inputs);

  // 输入数量断言：旧实现循环跑 inputs.length 次却用 tx.getInput(i)，
  // 若 PSBT 的输入比 inputs 多，多出来的输入会**静默不签**——用户拿到一个
  // 看起来"签好了"实际无效的 PSBT。
  if (tx.inputsLength !== inputs.length) {
    throw new Error(
      `PSBT input count ${tx.inputsLength} does not match provided inputs ${inputs.length}`,
    );
  }

  // 手续费上限 + 输出归属 + 未知地址，三项一次校验完毕。
  // 规则实现在 services/psbtPolicy —— **与单签共用同一份**。
  // 多签 PSBT 来自其他设备，一个被攻破的协调端可以多加一个输出到自己的地址
  // 而不改金额；仅靠 UI 摘要存在用户漏看风险，必须在签名端 hard-fail。
  //
  // 扫描窗口跟随本次输入的实际索引生长（见 signScanUpperBound），不再是固定 20。
  const scanUpper = signScanUpperBound(inputs.map((u) => u.derivationIndex));
  assertSignable(tx, vaultPolicyContext(vault, scanUpper, tx), { expectedExternalOutputs: 1 });

  for (let i = 0; i < inputs.length; i++) {
    const u = inputs[i];
    const key = `${u.txid}:${u.vout}`;
    const d = derivations.get(key);
    if (!d) {
      throw new Error(`Input ${i} (${key}) does not match this vault's derivation`);
    }
    const input = tx.getInput(i);
    const witnessUtxo = input.witnessUtxo;
    if (!witnessUtxo) {
      throw new Error(`Input ${i} missing witnessUtxo`);
    }
    if (!constantTimeEqual(witnessUtxo.script, d.script)) {
      throw new Error(`Input ${i} script mismatch — PSBT may be tampered`);
    }
    if (witnessUtxo.amount !== BigInt(u.value)) {
      throw new Error(`Input ${i} amount mismatch — PSBT may be tampered`);
    }
    const ws = input.witnessScript;
    if (!ws || !constantTimeEqual(ws, d.witnessScript)) {
      throw new Error(`Input ${i} witnessScript mismatch — PSBT may be tampered`);
    }
    const privKey = deriveSelfPrivateKeyAt(root, d.isChange, d.index, vault.accountIndex);
    try {
      tx.signIdx(privKey, i);
    } finally {
      privKey.fill(0);
    }
  }

  return base64.encode(tx.toPSBT());
}

export function inputsFromPsbt(
  psbtB64: string,
  selfCosignerXpub: string,
): VaultUtxo[] {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  const out: VaultUtxo[] = [];
  // Parse with the tolerant parser so a zpub/ypub/tpub cosigner xpub is accepted too.
  const account = parseExtKey(selfCosignerXpub);

  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const txidHex = input.txid ? bytesToHex(input.txid) : "";
    const vout = input.index ?? 0;
    const witnessUtxo = input.witnessUtxo;
    const value = witnessUtxo ? Number(witnessUtxo.amount) : 0;
    const derivations = input.bip32Derivation ?? [];
    if (derivations.length === 0) {
      throw new Error(`Input ${i} has no BIP32 derivation`);
    }
    // Find the derivation entry this device can actually reproduce from its own
    // xpub. Only our xpub can regenerate our pubkey, so this unambiguously
    // identifies our input — and works for ANY receive/change index, not just
    // receive index 0 (the previous fixed-pubkey check rejected change & nonzero
    // receive inputs outright).
    let matched: { isChange: boolean; index: number } | null = null;
    for (const [pubkey, info] of derivations) {
      const { isChange, index } = derivationToChangeIndex(info.path);
      const child = account.derive(`m/${isChange ? 1 : 0}/${index}`);
      if (child.publicKey && constantTimeEqual(child.publicKey, pubkey)) {
        matched = { isChange, index };
        break;
      }
    }
    if (!matched) {
      throw new Error(`Input ${i} has no BIP32 derivation matching this device's key`);
    }
    out.push({ txid: txidHex, vout, value, address: "", derivationIndex: matched.index, isChange: matched.isChange });
  }
  return out;
}

/**
 * 这笔 PSBT 属于哪个金库？
 *
 * 【旧实现是假匹配】VaultCosignScreen 用 `try { summarizePsbt(psbt, v, []) } catch`
 * 来挑金库 —— 但 summarizePsbt 走的是 reviewPsbtWithPolicy，**它对不匹配的金库
 * 不抛任何错**（纯只读汇总，knownInputs 传空时连派生表都是空的）。于是任何能
 * 解析的 PSBT 都会匹配上**列表里的第一个金库**。
 *
 * 用户只有一个金库时看不出问题；有两个及以上时，协签会把 PSBT 绑到错误的金库，
 * 随后 signVaultPsbtSelf 报 "does not match this vault's derivation"，
 * 而 UI 把它当成篡改，提示"PSBT 可能被篡改"——一个纯粹误导的死胡同。
 *
 * 真正的判据：PSBT 每个输入的 witnessUtxo.script，必须等于用这个金库的协签方
 * 集合在对应 (isChange, index) 上派生出来的 P2WSH script。这是密码学事实，
 * 不是启发式。
 */
export function matchVaultForPsbt(psbtB64: string, vaults: readonly VaultConfig[]): VaultConfig | null {
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  } catch {
    return null;
  }
  if (tx.inputsLength === 0) return null;

  for (const vault of vaults) {
    const selfCosigner = vault.cosigners.find((c) => c.role === "self");
    if (!selfCosigner) continue;
    let allMatched = true;
    for (let i = 0; i < tx.inputsLength && allMatched; i++) {
      const input = tx.getInput(i);
      const script = input.witnessUtxo?.script;
      if (!script) { allMatched = false; break; }
      // 从 bip32Derivation 读出 (isChange, index)，用本金库派生并比对 script。
      let matchedInput = false;
      for (const [, info] of input.bip32Derivation ?? []) {
        try {
          const { isChange, index } = derivationToChangeIndex(info.path);
          const derived = deriveVaultAddress(vault.cosigners, isChange, index, vault.m);
          if (constantTimeEqual(derived.script, script)) { matchedInput = true; break; }
        } catch {
          // 这个派生条目不适用于本金库，试下一个
        }
      }
      if (!matchedInput) allMatched = false;
    }
    if (allMatched) return vault;
  }
  return null;
}

export function combineVaultPsbt(aB64: string, bB64: string): string {
  const txA = Transaction.fromPSBT(base64.decode(aB64.trim()));
  const txB = Transaction.fromPSBT(base64.decode(bB64.trim()));
  // 结构校验：两笔 PSBT 的 inputs/outputs 必须完全一致，防止合并两笔不同交易
  // （@scure 的 combine 自身会拒，但提前显式校验给出更清晰错误且防边缘行为）。
  if (txA.inputsLength !== txB.inputsLength || txA.outputsLength !== txB.outputsLength) {
    throw new Error("Cannot combine: input/output count mismatch");
  }
  for (let i = 0; i < txA.inputsLength; i++) {
    const ia = txA.getInput(i);
    const ib = txB.getInput(i);
    if (!ia.txid || !ib.txid || !constantTimeEqual(ia.txid, ib.txid) || (ia.index ?? 0) !== (ib.index ?? 0)) {
      throw new Error(`Cannot combine: input ${i} mismatch`);
    }
  }
  for (let i = 0; i < txA.outputsLength; i++) {
    const oa = txA.getOutput(i);
    const ob = txB.getOutput(i);
    const sa = oa.script ?? new Uint8Array();
    const sb = ob.script ?? new Uint8Array();
    if (!constantTimeEqual(sa, sb) || (oa.amount ?? 0n) !== (ob.amount ?? 0n)) {
      throw new Error(`Cannot combine: output ${i} mismatch`);
    }
  }
  const combined = txA.combine(txB);
  return base64.encode(combined.toPSBT());
}

export function finalizeAndExtract(psbtB64: string): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  tx.finalize();
  const raw = tx.extract();
  return bytesToHex(raw);
}

export function summarizePsbt(psbtB64: string, vault: VaultConfig, knownInputs: VaultUtxo[] = []): PsbtSummary {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  const derivations = buildDerivationMap(vault, knownInputs);
  const inputs: PsbtSummary["inputs"] = [];
  const sigsPerInput: number[] = [];

  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const txidHex = input.txid ? bytesToHex(input.txid) : "";
    const vout = input.index ?? 0;
    const d = derivations.get(`${txidHex}:${vout}`);
    const witnessUtxo = input.witnessUtxo;
    const value = witnessUtxo ? Number(witnessUtxo.amount) : 0;
    inputs.push({
      txid: txidHex,
      vout,
      value,
      address: d?.address ?? "",
    });
    sigsPerInput.push(countPartialSigs(input.partialSig));
  }

  // 输出归属判定走 psbtPolicy —— 与 signVaultPsbtSelf 用的是**同一段解析**，
  // 杜绝"UI 摘要显示的找零"和"签名端判定的找零"是两回事。
  // 旧实现这里按 address 字符串比对，签名端按 script 字节比对，两套口径。
  const scanUpper = signScanUpperBound(knownInputs.map((u) => u.derivationIndex));
  const review = reviewPsbtWithPolicy(tx, vaultPolicyContext(vault, scanUpper, tx));
  const outputs: PsbtSummary["outputs"] = review.outputs.map((o) => ({
    address: o.address,
    sats: o.sats,
    isChange: o.isOwn,
  }));

  const requiredSigs = Math.max(1, vault.m);
  const readyToFinalize = sigsPerInput.length > 0 && sigsPerInput.every((c) => c >= requiredSigs);

  return {
    inputs,
    outputs,
    // feeSats 取自同一次 review（inputSats 来自 witnessUtxo，与签名端口径一致）。
    feeSats: Math.max(0, review.feeSats),
    signaturesPerInput: sigsPerInput,
    readyToFinalize,
  };
}

/**
 * 多签摘要里存在无法识别的输出地址 → UI 必须阻断签名。
 * 与单签 transaction.hasUnknownOutput 对称；旧实现多签侧完全没有这层。
 */
export function summaryHasUnknownOutput(summary: PsbtSummary): boolean {
  return anyUnknownOutput(summary.outputs);
}

function countPartialSigs(partial?: [Uint8Array, Uint8Array][]): number {
  if (!partial || partial.length === 0) return 0;
  // 按 pubkey 去重：同一 cosigner 的重复签名只计一次，避免 summarizePsbt 的
  // readyToFinalize 被重复签名误判为 true。
  const seen = new Set<string>();
  for (const [pubkey] of partial) seen.add(bytesToHex(pubkey));
  return seen.size;
}

// 收集 vault 自己派生树上的 p2wsh 输出脚本，覆盖 receive/change 各 [0, upper] 个索引。
// upper 由 signScanUpperBound 按本次输入的实际索引算出，不再是固定常量。
// 给 signVaultPsbtSelf 在签名循环前判定"哪个 output 是找零"用。
// 仅依赖 vault.cosigners (公开 xpub) 与 GAP_LIMIT，无需解锁钱包。
// vault 派生结果缓存：collectVaultScripts / summarizePsbt 每次调用都要派生
// 40+ 个多签地址（每个含 n 次 xpub 派生 + script 编码），可能在渲染路径上被反复触发。
const scriptCache = new Map<string, Uint8Array[]>();
const addressCache = new Map<string, Set<string>>();

function vaultCacheKey(vault: VaultConfig): string {
  return `${vault.id}:${vault.m}:${vault.accountIndex}:${vault.cosigners.map((c) => c.xpub).join(",")}`;
}

export function clearVaultDerivationCache(): void {
  scriptCache.clear();
  addressCache.clear();
}

function collectVaultScripts(vault: VaultConfig, upper: number): Uint8Array[] {
  const cacheKey = `${vaultCacheKey(vault)}@${upper}`;
  const hit = scriptCache.get(cacheKey);
  if (hit) return hit;
  const scripts: Uint8Array[] = [];
  for (const isChange of [false, true]) {
    for (let idx = 0; idx <= upper; idx++) {
      try {
        const derived = deriveVaultAddress(vault.cosigners, isChange, idx, vault.m);
        scripts.push(derived.script);
      } catch {
        // 单个索引派生失败跳过——不应让签名端因派生异常而全拒
      }
    }
  }
  scriptCache.set(cacheKey, scripts);
  return scripts;
}

/**
 * 单个 P2WSH 多签输入的 vbytes。
 * 41 non-witness + witness/4；witness = 1 + m*(1+73) 签名 + n*(1+33) 公钥 + 1 (OP_0)
 * + witnessScript(1 + n*(1+33) + OP_n + OP_CHECKMULTISIG)。
 *
 * 单独导出，供币选算法使用 —— 币选和估费必须用**同一个**数字，
 * 否则会选出"按币选算够、按估费算不够"的输入组合。
 */
export function vaultInputVbytes(m: number, n: number): number {
  const witnessSize = 1 + m * 74 + n * 34 + 1 + (1 + n * 34 + 2);
  return 41 + Math.ceil(witnessSize / 4);
}

/** P2WSH 输出 34 vB（1 长度 + 1 版本 + 1 push + 32 hash）。 */
export const VAULT_OUTPUT_VBYTES = 34;
/** 交易固定开销。 */
export const VAULT_OVERHEAD_VBYTES = 10;

export function estimateMultisigVbytes(inputCount: number, outputCount: number, m: number, n: number): number {
  return Math.ceil(
    inputCount * vaultInputVbytes(m, n) +
      outputCount * VAULT_OUTPUT_VBYTES +
      VAULT_OVERHEAD_VBYTES,
  );
}
