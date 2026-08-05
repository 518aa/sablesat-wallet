import { sortedMultisig } from "@scure/btc-signer/payment.js";
import { childPublicKeyAt } from "./cosigner";
import { getBtcNetwork } from "../network-mode";
import { bytesToHex } from "../crypto";
import type { Cosigner, DerivedVaultAddress } from "./types";

export type DerivedAddressResult = {
  address: string;
  witnessScript: Uint8Array;
  script: Uint8Array;
};

/**
 * @internal 仅供测试对照使用。
 * 生产代码**不需要**调用它——@scure 的 sortedMultisig 内部已按 BIP67 排序。
 * 留在这里容易让人误以为需要手动排序，故显式标注。
 */
export function sortedPubkeys(pubkeys: Uint8Array[]): Uint8Array[] {
  return [...pubkeys].sort((a, b) => {
    const hexA = bytesToHex(a);
    const hexB = bytesToHex(b);
    if (hexA < hexB) return -1;
    if (hexA > hexB) return 1;
    return 0;
  });
}

export function deriveVaultAddress(
  cosigners: Cosigner[],
  isChange: boolean,
  index: number,
  m: number = 2,
): DerivedAddressResult {
  // 边界校验：旧实现只查了 cosigners.length >= m。
  //   m=0  → 生成任何人都能花的 script
  //   n>15 → P2WSH 裸多签受 OP_1..OP_16 限制，无法编码
  if (!Number.isInteger(m) || m < 1) throw new Error(`Invalid threshold m=${m}`);
  if (cosigners.length < m) {
    throw new Error(`Need at least ${m} cosigners, got ${cosigners.length}`);
  }
  if (cosigners.length > 15) {
    throw new Error(`P2WSH multisig supports at most 15 keys, got ${cosigners.length}`);
  }
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid index ${index}`);
  const pubkeys = cosigners.map((c) => childPublicKeyAt(c.xpub, isChange, index));
  const payment = sortedMultisig(m, pubkeys, true, getBtcNetwork());
  if (!payment.address) throw new Error("Could not derive multisig address");
  if (!payment.witnessScript) throw new Error("Missing witnessScript on multisig payment");
  return {
    address: payment.address,
    witnessScript: payment.witnessScript,
    script: payment.script,
  };
}

export function deriveVaultAddressList(
  cosigners: Cosigner[],
  receiveCount: number,
  changeCount: number,
  m: number = 2,
): DerivedVaultAddress[] {
  const out: DerivedVaultAddress[] = [];
  for (let i = 0; i < receiveCount; i++) {
    out.push({ index: i, isChange: false, address: deriveVaultAddress(cosigners, false, i, m).address });
  }
  for (let i = 0; i < changeCount; i++) {
    out.push({ index: i, isChange: true, address: deriveVaultAddress(cosigners, true, i, m).address });
  }
  return out;
}

export function witnessScriptForAddress(
  cosigners: Cosigner[],
  isChange: boolean,
  index: number,
  m: number = 2,
): Uint8Array {
  return deriveVaultAddress(cosigners, isChange, index, m).witnessScript;
}
