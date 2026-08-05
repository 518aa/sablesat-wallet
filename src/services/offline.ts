import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { safeFetch } from "./hosts";
import { getApiBase } from "./network-mode";

// 真实探测 API 可达性（飞行模式软警告用）。
// 旧实现用 expo-network 的 isInternetReachable，它在"关 WiFi 但仍连移动数据"、
// 刚切换网络、或系统缓存未刷新时会不可靠地返回 true，导致离线终端误报"网络可达"。
// 改为直接尝试打一个轻量区块接口（3s 超时），任意节点成功才认定联网。
export async function isNetworkReachable(): Promise<boolean> {
  for (const base of getApiBase()) {
    try {
      const res = await safeFetch(`${base}/blocks/tip/height`, {}, 3000);
      if (res.ok) return true;
    } catch {
      // 节点不可达，试下一个
    }
  }
  return false;
}

export type PsbtValidationCode = "invalid" | "missingUtxo" | "missingDerivation" | "fingerprintRejected";

// PSBT 签名前完整性校验。返回 null 表示通过；否则返回错误码（i18n 文案用）。
// 防 PSBT 损坏或字段缺失导致签名端崩溃或盲签。
export function validatePsbtForSigning(psbtB64: string): PsbtValidationCode | null {
  let tx;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  } catch {
    return "invalid";
  }
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    if (!input.witnessUtxo) return "missingUtxo";
    if (!input.bip32Derivation || input.bip32Derivation.length === 0) {
      return "missingDerivation";
    }
  }
  return null;
}

// 签名终端指纹白名单校验。如果白名单非空，PSBT 中所有输入的 master fingerprint
// 必须都在白名单内，否则拒绝签名。空白名单表示不限制（向后兼容）。
export function validatePsbtFingerprints(
  psbtB64: string,
  allowed: string[],
): { ok: true } | { ok: false; rejected: string[] } {
  if (!allowed || allowed.length === 0) return { ok: true };

  let tx;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  } catch {
    return { ok: false, rejected: ["invalid-psbt"] };
  }

  const rejected: string[] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const derivations = input.bip32Derivation;
    // fail-closed：白名单启用时，无 bip32Derivation 的输入无法证明归属，一律拒绝。
    if (!derivations || derivations.length === 0) {
      rejected.push(`input-${i}:no-derivation`);
      continue;
    }

    for (const d of derivations) {
      // bip32Derivation entries are [pubkey, {fingerprint, path}] tuples
      const fpHex = fingerprintToHex(d[1].fingerprint);
      if (!allowed.includes(fpHex)) {
        rejected.push(fpHex);
      }
    }
  }

  if (rejected.length > 0) return { ok: false, rejected: [...new Set(rejected)] };
  return { ok: true };
}

function fingerprintToHex(fp: number): string {
  // master fingerprint is 4 bytes, big-endian
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, fp, false);
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}
