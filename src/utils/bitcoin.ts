import * as btc from "@scure/btc-signer";
import { getBtcNetwork } from "../services/network-mode";

export const SATS_PER_BTC = 100_000_000;
export const DUST_THRESHOLD_SATS = 546;

// 手续费相关的常量与判定已统一到 services/feePolicy —— 单签与多签必须共用同一份
// 规则，否则会造出"造得出来、自己签不动"的 PSBT（改之前多签钳到 5000 sat/vB，
// 而签名端拒绝 >500）。这里只做 re-export 保持旧 import 可用。
export {
  MAX_FEE_RATIO,
  MIN_FEE_RATE,
  MAX_FEE_RATE,
  clampFeeRate,
} from "../services/feePolicy";

export class InvalidAmountError extends Error {
  constructor(public readonly input: string) {
    super(`Invalid BTC amount: ${input}`);
  }
}

/**
 * BTC 字符串 → sats。
 *
 * 旧实现对非法输入**静默返回 0**（比如用户输入 ".5"），UI 无法区分「无效输入」
 * 和「零金额」——在支付路径上这种降级很危险。现在返回 null，由调用方显式处理。
 */
export function btcToSatsOrNull(input: string): number | null {
  const normalized = input.trim();
  if (!normalized) return null;
  // 允许 ".5" / "0.5" / "1." 三种写法
  if (!/^\d*(\.\d{0,8})?$/.test(normalized)) return null;
  if (normalized === "." || normalized === "") return null;
  const [whole = "", fraction = ""] = normalized.split(".");
  const satsText = `${whole || "0"}${fraction.padEnd(8, "0")}`;
  const sats = Number(satsText);
  if (!Number.isSafeInteger(sats) || sats < 0) return null;
  return sats;
}

/** 抛错版本，用于必须有合法金额的路径。 */
export function btcToSats(input: string): number {
  const sats = btcToSatsOrNull(input);
  if (sats === null) throw new InvalidAmountError(input);
  return sats;
}

export function satsToBtc(sats: number): string {
  const sign = sats < 0 ? "-" : "";
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / SATS_PER_BTC);
  const fraction = String(abs % SATS_PER_BTC).padStart(8, "0");
  return `${sign}${whole}.${fraction}`;
}

export function validateBtcAddress(address: string): boolean {
  const candidate = address.trim();
  if (!candidate) return false;
  try {
    btc.Address(getBtcNetwork()).decode(candidate);
    return true;
  } catch {
    return false;
  }
}

export function estimateTxVbytes(inputCount: number, outputCount: number): number {
  // P2WPKH: input ≈ 68 vB, output ≈ 31 vB, overhead ≈ 10.5 vB
  return Math.ceil(inputCount * 68 + outputCount * 31 + 11);
}

/**
 * 解析 BTC 收款二维码：BIP21 `bitcoin:<address>?amount=`，也接受裸地址。
 * 按 BIP21，无法识别的 `req-` 参数必须导致整体拒绝。
 */
export function parseBitcoinUri(
  raw: string,
): { address: string; amountSats?: number; label?: string } | null {
  const trimmed = raw.trim();
  const m = trimmed.match(/^bitcoin:([^?]+)(?:\?(.*))?$/i);
  if (m) {
    const address = m[1].split("/")[0];
    if (!validateBtcAddress(address)) return null;
    const params = new URLSearchParams(m[2] ?? "");
    // BIP21：不认识的 req- 参数必须拒绝，不能忽略后照常付款
    for (const key of params.keys()) {
      if (key.toLowerCase().startsWith("req-")) return null;
    }
    const rawAmount = params.get("amount");
    let amountSats: number | undefined;
    if (rawAmount !== null) {
      const parsed = btcToSatsOrNull(rawAmount);
      if (parsed === null) return null; // 金额字段存在但非法 → 整体拒绝
      amountSats = parsed;
    }
    return { address, amountSats, label: params.get("label") ?? undefined };
  }
  if (validateBtcAddress(trimmed)) return { address: trimmed };
  return null;
}
