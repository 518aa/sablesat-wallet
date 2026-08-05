// ───────────────────────────────────────────────────────────────────────────
// 手续费风控：**单签与多签共用的唯一实现**。
//
// 【为什么要合并】改之前 transaction.assertFeeSane 与 vault/psbt.assertVaultFeeSane
// 是两份几乎逐行相同的代码，各自漂移出了不一致的规则：
//   - feeRate 钳制区间：单签 [1,500]，多签 [1,5000]
//   - 而两边的绝对上限都是 500 sat/vB → 多签按 600 造出来的 PSBT，自己的签名端
//     直接拒签，用户拿到一个"造得出来、签不动"的交易
// 规则只应该写一遍。差异（脚本类型的 vbytes 估算）通过参数注入。
//
// 【为什么把 10% 比例上限改成分级】旧实现是 `fee > inTotal * 0.1` 一律 hard fail。
// 实测两个完全正常的场景被误杀：
//   - 30000 sat UTXO 发 20000 @25 sat/vB → fee 3525 = 11.8% → 拒绝，用户根本发不出去
//   - 归集 10 个 5000 sat 的 UTXO @30 sat/vB → 43% → 拒绝
// 小额支付和 UTXO 归集的手续费占比天然就高，这不是攻击特征。
//
// 现在的分层：
//   1. 绝对费率上限（sat/vB）—— 这才是真正的硬边界，任何情况下都不该越过
//   2. 比例上限只在**费用绝对值也很大**时才生效 —— 攻击者要偷的是钱，
//      偷 3000 sats 不值得构造攻击；真正的攻击形态是"把 0.5 BTC 变成矿工费"
//   3. 介于两者之间的返回 warning，由 UI 做二次确认，而不是 hard fail
//
// 原则：能导致"钱取不出来"的风控，必须给用户一条明确的路，而不是一堵墙。
// ───────────────────────────────────────────────────────────────────────────

/** 绝对费率上限（sat/vB）。历史上主网拥堵极值也很少超过 300。 */
export const MAX_FEE_RATE_ABSOLUTE = 500;

/** 比例上限。仅在费用绝对值超过 RATIO_GUARD_MIN_FEE_SATS 时才生效。 */
export const MAX_FEE_RATIO = 0.1;

/**
 * 比例上限的启用门槛。低于这个绝对值时，高占比只是"小额交易的正常现象"，
 * 不是攻击。0.0005 BTC ≈ 几十元人民币量级。
 */
export const RATIO_GUARD_MIN_FEE_SATS = 50_000;

/** 无论金额多小，费用超过输入总额这个比例一律拒绝——这已经不是手续费了。 */
export const ABSOLUTE_MAX_FEE_RATIO = 0.5;

/** 需要用户二次确认的费率门槛（sat/vB）。 */
export const FEE_RATE_WARN_THRESHOLD = 200;

export class ExcessiveFeeError extends Error {
  constructor(
    public readonly feeSats: number,
    public readonly inputSum: number,
    public readonly reason: "rate" | "ratio" | "negative",
  ) {
    super(`Fee ${feeSats} sats rejected (${reason}) for input total ${inputSum} sats`);
  }
}

export type FeeVerdict = {
  feeSats: number;
  inputSats: number;
  vbytes: number;
  feeRate: number;
  /** 非致命但异常，UI 应要求用户二次确认。 */
  warnings: Array<"high-rate" | "high-ratio">;
};

export type FeeCheckInput = {
  inputSats: number;
  outputSats: number;
  /** 按实际脚本类型估算的 vbytes（P2WPKH 与 P2WSH 差异很大，必须由调用方给）。 */
  vbytes: number;
};

/**
 * 唯一的手续费判定入口。
 * @throws ExcessiveFeeError 命中硬边界
 */
export function checkFee({ inputSats, outputSats, vbytes }: FeeCheckInput): FeeVerdict {
  const feeSats = inputSats - outputSats;
  if (feeSats < 0) throw new ExcessiveFeeError(feeSats, inputSats, "negative");

  const safeVbytes = Math.max(1, vbytes);
  const feeRate = feeSats / safeVbytes;
  const ratio = inputSats > 0 ? feeSats / inputSats : 0;

  // 硬边界 1：绝对费率。与网络状况无关，越过就是异常。
  if (feeRate > MAX_FEE_RATE_ABSOLUTE) {
    throw new ExcessiveFeeError(feeSats, inputSats, "rate");
  }
  // 硬边界 2：比例，但只在费用绝对值也大时生效（见文件头）。
  if (feeSats >= RATIO_GUARD_MIN_FEE_SATS && ratio > MAX_FEE_RATIO) {
    throw new ExcessiveFeeError(feeSats, inputSats, "ratio");
  }
  // 硬边界 3：无论金额大小，吃掉一半以上输入都不可能是正常手续费。
  if (ratio > ABSOLUTE_MAX_FEE_RATIO) {
    throw new ExcessiveFeeError(feeSats, inputSats, "ratio");
  }

  const warnings: FeeVerdict["warnings"] = [];
  if (feeRate > FEE_RATE_WARN_THRESHOLD) warnings.push("high-rate");
  if (ratio > MAX_FEE_RATIO) warnings.push("high-ratio");

  return { feeSats, inputSats, vbytes: safeVbytes, feeRate, warnings };
}

/** 费率钳制区间。单签与多签必须一致，否则会造出自己签不了的 PSBT。 */
export const MIN_FEE_RATE = 1;
export const MAX_FEE_RATE = MAX_FEE_RATE_ABSOLUTE;

export function clampFeeRate(feeRate: number): number {
  if (!Number.isFinite(feeRate)) return MIN_FEE_RATE;
  return Math.min(MAX_FEE_RATE, Math.max(MIN_FEE_RATE, Math.round(feeRate)));
}
