import { HDKey } from "@scure/bip32";
import { base58 } from "@scure/base";
import { doubleSha256 } from "./crypto";
import type { NetworkMode } from "./network-mode";

// ───────────────────────────────────────────────────────────────────────────
// 扩展密钥解析 / 规范化。
//
// @scure/bip32 的 HDKey.fromExtendedKey 默认只认 xpub/xprv 版本字节，遇到
// zpub/ypub/tpub 会抛 "Version mismatch"。这些前缀只是**同一份密钥材料**的
// 不同序列化——版本字节只影响再序列化，从不影响派生，所以 zpub 派生出的地址
// 与 xpub 派生出的逐字节相同。这里通过传入对应 versions 表来兼容。
//
// 【本次加固】
//   1. **默认拒绝私钥**（xprv/zprv/tprv…）。旧实现的 isValidCosignerXpub 是
//      `Boolean(parseExtKey(v).publicKey)`——xprv 解析后同样有 publicKey，
//      所以校验通过，然后被原样写进 vault config **和导出的 output descriptor**。
//      用户被要求把描述符打印/拍照/抄纸备份，私钥就跟着出去了。
//   2. **网络前缀校验**。旧实现主网金库可以混进 tpub 协签方且完全不报错
//      （派生能跑通，因为版本字节不参与派生），导出的描述符在对端无法使用。
//   3. **补上 vpub**。旧表里注释写着 "upub / vpub"，但只有 upub 的版本字节
//      （0x044a5262）；vpub 是 0x045f1cf6 —— 而本 App 自己的 getAccountZpub()
//      在测试网导出的正是 vpub，导出的东西自己解析不回来。
//   4. **规范化为 xpub/tpub**。BIP380 描述符里 wsh() 的规范形式是 xpub；
//      原样写 zpub 会被 Bitcoin Core 拒绝导入，而描述符是多签唯一恢复路径。
// ───────────────────────────────────────────────────────────────────────────

export const XPUB_VERSION = 0x0488b21e;
export const TPUB_VERSION = 0x043587cf;

type VersionEntry = {
  public: number;
  private: number;
  network: NetworkMode;
  label: string;
};

// 兼容 xpub 私钥版本字节所需的占位（解析私钥时用；本模块默认拒绝私钥）。
const XPRV_VERSION = 0x0488ade4;
const TPRV_VERSION = 0x04358394;

const VERSION_TABLE: readonly VersionEntry[] = [
  { public: XPUB_VERSION, private: XPRV_VERSION, network: "mainnet", label: "xpub" },
  { public: 0x049d7cb2, private: 0x049d7878, network: "mainnet", label: "ypub" },
  { public: 0x04b24746, private: 0x04b2430c, network: "mainnet", label: "zpub" },
  { public: 0x0295b43f, private: 0x0295b005, network: "mainnet", label: "Ypub" },
  { public: 0x02aa7ed3, private: 0x02aa7a99, network: "mainnet", label: "Zpub" },
  { public: TPUB_VERSION, private: TPRV_VERSION, network: "testnet", label: "tpub" },
  { public: 0x044a5262, private: 0x044a4e28, network: "testnet", label: "upub" },
  { public: 0x045f1cf6, private: 0x045f18bc, network: "testnet", label: "vpub" },
  { public: 0x024289ef, private: 0x024285b5, network: "testnet", label: "Upub" },
  { public: 0x02575483, private: 0x02575048, network: "testnet", label: "Vpub" },
];

/** 保留旧导出名，避免调用方大改。 */
export const ZPUB_VERSIONS = { public: 0x04b24746, private: 0x04b2430c };

export class PrivateKeyNotAllowedError extends Error {
  constructor() {
    super(
      "Extended PRIVATE key supplied where a public key is required. " +
        "Never paste an xprv/zprv/tprv as a cosigner — it would be written into the backup descriptor.",
    );
  }
}

export class ExtKeyNetworkMismatchError extends Error {
  constructor(
    public readonly keyNetwork: NetworkMode,
    public readonly expected: NetworkMode,
  ) {
    super(`Extended key is a ${keyNetwork} key but the wallet is in ${expected} mode`);
  }
}

export type ExtKeyInfo = {
  node: HDKey;
  /** 该序列化前缀所属网络。 */
  network: NetworkMode;
  /** 前缀标签（xpub / zpub / tpub …）。 */
  label: string;
  /** 是否是扩展私钥。 */
  isPrivate: boolean;
};

function decodeRaw(key: string): { payload: Uint8Array; version: number } {
  const decoded = base58.decode(key);
  if (decoded.length !== 82) throw new Error("Invalid extended key length");
  const body = decoded.slice(0, 78);
  const checksum = decoded.slice(78);
  const expected = doubleSha256(body).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) throw new Error("Extended key checksum mismatch");
  }
  const version = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false);
  return { payload: body, version };
}

/**
 * 解析扩展密钥并返回前缀元信息。
 * @throws 校验和错误 / 未知版本字节
 */
export function inspectExtKey(key: string): ExtKeyInfo {
  const trimmed = key.trim();
  const { version } = decodeRaw(trimmed);
  const entry = VERSION_TABLE.find((v) => v.public === version || v.private === version);
  if (!entry) {
    throw new Error(`Unsupported extended key version 0x${version.toString(16).padStart(8, "0")}`);
  }
  const isPrivate = entry.private === version;
  const node = HDKey.fromExtendedKey(trimmed, { public: entry.public, private: entry.private });
  return { node, network: entry.network, label: entry.label, isPrivate };
}

export type ParseExtKeyOptions = {
  /**
   * 拒绝扩展私钥。**默认 true** —— 本项目里所有 parseExtKey 调用点
   * （cosigner / descriptor / watch-only / PSBT）都只应接受公钥。
   */
  publicOnly?: boolean;
  /** 校验前缀所属网络。传入后不匹配即抛错。 */
  expectNetwork?: NetworkMode;
};

/**
 * 解析任意 BIP32 扩展公钥（xpub/zpub/ypub/tpub/vpub/…）为 HDKey。
 * 默认拒绝扩展私钥——见文件头注释 1。
 */
export function parseExtKey(key: string, opts: ParseExtKeyOptions = {}): HDKey {
  const { publicOnly = true, expectNetwork } = opts;
  const info = inspectExtKey(key);
  if (publicOnly && info.isPrivate) throw new PrivateKeyNotAllowedError();
  if (expectNetwork && info.network !== expectNetwork) {
    throw new ExtKeyNetworkMismatchError(info.network, expectNetwork);
  }
  return info.node;
}

function base58check(payload: Uint8Array): string {
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(doubleSha256(payload).slice(0, 4), payload.length);
  return base58.encode(full);
}

/**
 * 把任意公钥前缀（zpub/ypub/vpub/…）重序列化为 BIP380 描述符里的规范形式：
 * 主网 xpub / 测试网 tpub。
 *
 * 【为什么必须做】描述符是多签唯一可靠的恢复路径。原样写 zpub 时 Sparrow 能
 * 容忍，Bitcoin Core 会直接拒绝导入——用户以为备份好了，真要恢复时才发现不行。
 */
export function toCanonicalExtPubKey(key: string, network?: NetworkMode): string {
  const trimmed = key.trim();
  const info = inspectExtKey(trimmed);
  if (info.isPrivate) throw new PrivateKeyNotAllowedError();
  const target = network ?? info.network;
  if (network && info.network !== network) {
    throw new ExtKeyNetworkMismatchError(info.network, network);
  }
  const version = target === "testnet" ? TPUB_VERSION : XPUB_VERSION;
  const { payload } = decodeRaw(trimmed);
  const out = new Uint8Array(78);
  out.set(payload, 0);
  new DataView(out.buffer).setUint32(0, version, false);
  return base58check(out);
}

/** 该扩展密钥是否为扩展私钥（用于 UI 即时提示，不抛错）。 */
export function isExtendedPrivateKey(key: string): boolean {
  try {
    return inspectExtKey(key).isPrivate;
  } catch {
    return false;
  }
}
