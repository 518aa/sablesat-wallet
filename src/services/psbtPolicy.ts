import type { Transaction } from "@scure/btc-signer/transaction.js";
import { constantTimeEqual } from "./crypto";
import { checkFee, type FeeVerdict } from "./feePolicy";
import { UNKNOWN_OUTPUT_ADDRESS, anyUnknownOutput } from "./psbtCommon";

// ───────────────────────────────────────────────────────────────────────────
// PSBT 审查策略：**单签与多签共用的唯一实现**。
//
// 【根因 5 的收口】改之前这套判定在两个地方各写了一遍，成对但不一致：
//
//   |            | 单签 transaction.ts        | 多签 vault/psbt.ts        |
//   |------------|----------------------------|---------------------------|
//   | 费率钳制   | [1, 500]                   | [1, 5000]  ← 自己签不动    |
//   | vbytes     | estimateTxVbytes (P2WPKH)  | estimateMultisigVbytes    |
//   | 未知地址   | "?" sentinel + 阻断        | 空串，无阻断  ← 更该严格   |
//   | send-max   | 支持                       | 不支持     ← 金库无法清仓  |
//   | 归属窗口   | scanWalletAddresses 动态   | 固定常量 20 ← 超了就砖     |
//
// 五处差异没有一处是有意设计的，全是两份拷贝各自漂移的结果。费率那一份上一轮
// 已经收进 feePolicy；这里收的是输出归属判定与摘要。
//
// 差异通过**参数注入**表达，规则只写一遍：
//   - vbyteEstimator：脚本类型不同（P2WPKH 68 vB/input vs P2WSH 100+）
//   - ownScripts：自有脚本集合的来源不同（派生树 vs vault 协签方集合）
//   - addressDecoder：地址反解方式不同（两边 @scure API 用法不同）
// ───────────────────────────────────────────────────────────────────────────

export type PsbtOutputView = {
  address: string;
  sats: number;
  /** 该输出属于本钱包 / 本金库（找零或自转）。 */
  isOwn: boolean;
};

export type PsbtReview = {
  inputCount: number;
  inputSats: number;
  outputs: PsbtOutputView[];
  outputSats: number;
  feeSats: number;
  /** 不属于自己的输出个数。正常支付应恰好为 1。 */
  externalOutputs: number;
  /** 存在无法反解地址的输出 —— UI 必须据此阻断签名。 */
  hasUnknownOutput: boolean;
};

export type PsbtPolicyContext = {
  /** 自有输出脚本集合，用于判定"这个输出是不是找零"。 */
  ownScripts: readonly Uint8Array[];
  /** 按实际脚本类型估算 vbytes。 */
  vbyteEstimator: (inputCount: number, outputCount: number) => number;
  /** 输出脚本 → 地址。失败返回 null，由本模块统一换成 "?" sentinel。 */
  addressDecoder: (script: Uint8Array, index: number) => string | null;
};

function sumInputs(tx: Transaction): number {
  let sum = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const wu = tx.getInput(i).witnessUtxo;
    if (wu?.amount) sum += wu.amount;
  }
  return Number(sum);
}

/**
 * 解析并审查一笔 PSBT。**不做任何签名动作**，纯只读。
 * 单签与多签路径都先经过这里，再各自补充脚本/派生校验。
 */
export function reviewPsbtWithPolicy(tx: Transaction, ctx: PsbtPolicyContext): PsbtReview {
  const inputSats = sumInputs(tx);
  const outputs: PsbtOutputView[] = [];
  let outputSats = 0;
  let externalOutputs = 0;

  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const script = out.script ?? new Uint8Array();
    const sats = Number(out.amount ?? 0n);
    outputSats += sats;

    // 归属判定用 constantTimeEqual：这里比的是攻击者可控的数据，
    // 逐字节短路比较会泄露"匹配到第几个字节"这一信息。
    const isOwn = ctx.ownScripts.some((s) => constantTimeEqual(s, script));
    if (!isOwn) externalOutputs++;

    let address: string;
    try {
      address = ctx.addressDecoder(script, i) ?? UNKNOWN_OUTPUT_ADDRESS;
    } catch {
      address = UNKNOWN_OUTPUT_ADDRESS;
    }
    outputs.push({ address, sats, isOwn });
  }

  return {
    inputCount: tx.inputsLength,
    inputSats,
    outputs,
    outputSats,
    feeSats: inputSats - outputSats,
    externalOutputs,
    hasUnknownOutput: anyUnknownOutput(outputs),
  };
}

export class OutputsTamperedError extends Error {
  constructor(
    public readonly externalOutputs: number,
    public readonly expected: number,
  ) {
    super(
      `PSBT outputs tampered: expected ${expected} external recipient(s), found ${externalOutputs}`,
    );
  }
}

export class UnknownOutputError extends Error {
  constructor() {
    super("PSBT contains an output whose address could not be decoded — refusing to sign");
  }
}

export type SignGuardOptions = {
  /** 允许的外部（非自有）输出数。普通支付为 1。 */
  expectedExternalOutputs?: number;
  /** 是否允许存在无法反解地址的输出。默认 false（拒签）。 */
  allowUnknownOutputs?: boolean;
};

/**
 * 签名前的统一硬校验。**必须在任何签名动作之前调用。**
 *
 * 【检查顺序：先结构，后总量】
 *
 * 我最初写成了"先 fee 后 outputs"，理由是"总量异常时结构再对也没意义"。
 * 那个理由是**反的**，而且既有测试立刻抓到了：
 * signVaultPsbtSelf.test 里"攻击者注入第二个收款输出"的用例，因为注入的输出
 * 让 outputs > inputs，fee 变成负数，于是先报了 `Fee -17910 sats (negative)`。
 *
 * 交易被拒了，安全上没有回归 —— 但报出来的是**症状而不是病因**。负手续费
 * 恰恰是输出被篡改的结果；用户/日志看到"手续费为负"完全无法据此判断发生了
 * 什么，而"预期 1 个外部收款方，发现 2 个"是可以直接行动的信息。
 *
 * 所以：结构检查（未知地址 → 输出归属）在前，总量检查（手续费上限）在后。
 * 两者都不放过，只是让最具诊断价值的那个先说话。
 */
export function assertSignable(
  tx: Transaction,
  ctx: PsbtPolicyContext,
  opts: SignGuardOptions = {},
): { review: PsbtReview; fee: FeeVerdict } {
  const review = reviewPsbtWithPolicy(tx, ctx);

  // 无法反解的输出：攻击者可以用非标脚本让 UI 显示空白地址，用户容易当成
  // "地址被截断"而照签。旧实现多签侧完全没有这层，而多签 PSBT 恰恰来自外部设备。
  if (!opts.allowUnknownOutputs && review.hasUnknownOutput) {
    throw new UnknownOutputError();
  }

  const expected = opts.expectedExternalOutputs ?? 1;
  if (review.externalOutputs !== expected) {
    throw new OutputsTamperedError(review.externalOutputs, expected);
  }

  const fee = checkFee({
    inputSats: review.inputSats,
    outputSats: review.outputSats,
    vbytes: ctx.vbyteEstimator(tx.inputsLength, tx.outputsLength),
  });

  return { review, fee };
}
