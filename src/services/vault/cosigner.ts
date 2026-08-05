import { HDKey } from "@scure/bip32";
import { getSelfDerivationPath, type Cosigner } from "./types";
import { parseExtKey } from "../extkey";
import { bytesToHex, hexToBytes } from "../crypto";
import { parseBip32Path } from "../wallet";
import { getNetworkModeSync } from "../network-mode";

export function deriveSelfCosigner(root: HDKey, accountIndex = 0): Cosigner {
  const path = getSelfDerivationPath(getNetworkModeSync(), accountIndex);
  const account = root.derive(path);
  if (!account.publicKey) throw new Error("Could not derive self cosigner public key");
  const xpub = account.publicExtendedKey;
  if (!xpub) throw new Error("Could not serialize self cosigner xpub");
  return {
    role: "self",
    name: "This device",
    xpub,
    derivationPath: path,
    fingerprint: fingerprintToHex(root.fingerprint),
  };
}

function fingerprintToHex(fp: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, fp >>> 0, false);
  return bytesToHex(bytes);
}

export function childPublicKeyAt(xpub: string, isChange: boolean, index: number): Uint8Array {
  const account = parseExtKey(xpub);
  const child = account.derive(`m/${isChange ? 1 : 0}/${index}`);
  if (!child.publicKey) throw new Error(`Could not derive pubkey from xpub at ${isChange ? 1 : 0}/${index}`);
  return child.publicKey;
}

export function deriveSelfPrivateKeyAt(
  root: HDKey,
  isChange: boolean,
  index: number,
  accountIndex = 0,
): Uint8Array {
  const path = getSelfDerivationPath(getNetworkModeSync(), accountIndex);
  const child = root.derive(`${path}/${isChange ? 1 : 0}/${index}`);
  if (!child.privateKey) throw new Error("Could not derive self cosigner private key");
  // **返回副本**。旧实现返回 HDKey 内部缓冲的引用，而调用方
  // （signVaultPsbtSelf）在 finally 里 privKey.fill(0) —— 那是在抹 HDKey 自己的
  // 内部状态。目前因为节点即用即弃没暴雷，但与 wallet.deriveKeyForPath（返回
  // 副本）的约定不一致，是个定时炸弹。
  return new Uint8Array(child.privateKey);
}

/**
 * 协签方扩展公钥是否可用。
 *
 * parseExtKey 现在默认 publicOnly —— 旧实现是 `Boolean(parseExtKey(v).publicKey)`，
 * 而 xprv 解析后同样有 publicKey，于是私钥能通过校验并被写进导出的描述符。
 * 同时校验网络前缀，防止主网金库混进 tpub。
 */
export function isValidCosignerXpub(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 78) return false;
  try {
    const account = parseExtKey(trimmed, { expectNetwork: getNetworkModeSync() });
    return Boolean(account.publicKey);
  } catch {
    return false;
  }
}

export class MissingMasterFingerprintError extends Error {
  constructor(public readonly cosignerName: string) {
    super(
      `Cosigner "${cosignerName}" has no master fingerprint. ` +
        `It cannot be derived from an account-level xpub — re-add this cosigner using the full ` +
        `key expression exported by its device, e.g. [f0e1d2c3/48h/0h/0h/2h]xpub6...`,
    );
  }
}

/**
 * 协签方 master fingerprint（BIP32 key origin 用）。
 *
 * 【为什么不能有回退分支】master fingerprint 是 hash160(master pubkey) 的前 4
 * 字节，**从 account 级 xpub 数学上推不出来**。旧实现的回退是
 * `parseExtKey(xpub).fingerprint`，那取到的是 account 节点自身的指纹，不是
 * master —— 写进 PSBT 的 bip32Derivation 后，对端硬件钱包按 master fingerprint
 * 匹配会直接认不出这是自己的输入，协签失败；写进 descriptor 后同理，Sparrow /
 * Core 关联不到设备，恢复失败。
 *
 * 一个悄悄错掉的指纹比一个明确的报错危险得多（用户会以为金库建好了并往里打钱），
 * 所以这里**没有回退**，缺失直接抛错。
 */
export function cosignerFingerprint(cosigner: Cosigner): number {
  if (!cosigner.fingerprint || !/^[0-9a-fA-F]{8}$/.test(cosigner.fingerprint)) {
    throw new MissingMasterFingerprintError(cosigner.name || cosigner.role);
  }
  const fpBytes = hexToBytes(cosigner.fingerprint);
  return new DataView(fpBytes.buffer, fpBytes.byteOffset, fpBytes.byteLength).getUint32(0, false);
}

export type CosignerInputDerivation = {
  pubkey: Uint8Array;
  fingerprint: number;
  path: number[];
};

export function cosignerInputDerivation(
  cosigner: Cosigner,
  isChange: boolean,
  index: number,
): CosignerInputDerivation {
  const base = parseBip32Path(cosigner.derivationPath);
  const path = [...base, isChange ? 1 : 0, index];
  const pubkey = childPublicKeyAt(cosigner.xpub, isChange, index);
  const fingerprint = cosignerFingerprint(cosigner);
  return { pubkey, fingerprint, path };
}

export function derivationToChangeIndex(path: number[]): { isChange: boolean; index: number } {
  if (path.length < 2) throw new Error("Derivation path too short");
  const last = path[path.length - 1];
  const parent = path[path.length - 2];
  if (parent !== 0 && parent !== 1) throw new Error(`Unexpected change segment: ${parent}`);
  if (!Number.isInteger(last) || last < 0) throw new Error(`Unexpected index segment: ${last}`);
  return { isChange: parent === 1, index: last };
}
