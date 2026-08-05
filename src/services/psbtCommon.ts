// 单签 / 多签 PSBT 审查路径共用的常量与判定。
//
// 放在独立模块是为了打破依赖方向：transaction.ts 依赖 vault/psbt.ts
// （复用 finalizeAndExtract），所以 vault/psbt.ts 不能反向 import transaction.ts。
// 两边都从这里取。

/**
 * 无法解析出地址的输出脚本占位符。
 *
 * 为什么用 "?" 而不是空串：攻击者可以用非标脚本让 UI 显示空白地址，用户容易
 * 当成"自己地址的前缀被截断了"而照签。sentinel 是明确的"这里有问题"信号，
 * 调用方必须据此阻断签名。
 */
export const UNKNOWN_OUTPUT_ADDRESS = "?";

export function isUnknownOutputAddress(address: string): boolean {
  return address === UNKNOWN_OUTPUT_ADDRESS || address === "";
}

/** 任一输出地址无法识别 → 阻断签名。单签与多签摘要都适用。 */
export function anyUnknownOutput(outputs: Array<{ address: string }>): boolean {
  return outputs.some((o) => isUnknownOutputAddress(o.address));
}

// ───────────────────────────────────────────────────────────────────────────
// 气隙回程校验：**扫回来的已签 PSBT,必须就是我发出去的那一笔。**
//
// 【为什么这是气隙模型的命门】离线签名的全部安全性建立在两步上：
//   ① 离线端只签它看得懂的东西（signPsbtOffline 有派生路径 + script 校验）
//   ② **在线端核对回传结果**
// 缺了 ②，气隙就退化成"多按几次按钮"：被掉包的离线设备、被替换的二维码，
// 都能回传一笔收款方完全不同的已签交易，而在线端照单广播。
//
// 观察钱包此前就缺 ②：确认页显示的是**用户在表单里输入的** recipient / amount，
// 扫回来的 PSBT 一行都没校验就直接广播。用户看到的确认信息是自己的意图，
// 不是即将上链的事实。
// ───────────────────────────────────────────────────────────────────────────

export class PsbtMismatchError extends Error {
  constructor(
    public readonly expectedTxid: string,
    public readonly actualTxid: string,
  ) {
    super(
      `Signed PSBT does not match the transaction that was built ` +
        `(expected ${expectedTxid}, got ${actualTxid})`,
    );
    this.name = "PsbtMismatchError";
  }
}

/**
 * 两笔 PSBT 是否是**同一笔交易**（签名可以不同）。
 *
 * 判据用 txid 而不是逐字段比对：隔离见证的 txid 按定义**不包含见证数据**，
 * 所以「签名」这个动作不会改变 txid。反过来说，只要输入集合、输出集合、金额、
 * nSequence、nLockTime、version 里任何一项被改动，txid 必变。
 *
 * 这比手写字段比对更强：不会漏掉将来新增的交易字段。
 *
 * 注意：本钱包全程原生隔离见证（BIP84 P2WPKH / P2WSH 多签），finalScriptSig
 * 恒为空，所以 finalize 前后 txid 也一致。若将来引入 P2SH 包装的隔离见证，
 * 这个不变量会失效，必须改用逐字段比对。
 */
export function isSamePsbtTransaction(
  txidOf: (psbtB64: string) => string,
  expectedPsbtB64: string,
  actualPsbtB64: string,
): boolean {
  return txidOf(expectedPsbtB64) === txidOf(actualPsbtB64);
}
