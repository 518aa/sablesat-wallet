import { parseExtKey, toCanonicalExtPubKey, inspectExtKey, PrivateKeyNotAllowedError } from "../extkey";
import { parseBip32Path, pathToString } from "../wallet";
import { constantTimeEqual } from "../crypto";
import { getNetworkModeSync } from "../network-mode";
import type { Cosigner, VaultConfig } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// BIP380 输出描述符（output descriptor）导出 / 导入。
//
// 【为什么这是最高优先级的缺口】
// 之前 vault 配置（n 个 xpub + m/n + 脚本类型）**只存在 AsyncStorage 一处**，
// 用 root 派生的密钥加密。设备丢失/损坏后，即使完整保存了助记词，多签资产
// 也拿不回来——恢复 2-of-3 需要知道另外两个 cosigner 的 xpub，而这份信息
// 随设备一起没了。这是多签用户丢币的头号原因，比私钥泄露常见得多。
//
// 描述符格式：
//   wsh(sortedmulti(2,
//     [a1b2c3d4/48h/0h/0h/2h]xpub6.../<0;1>/*,
//     ...
//   ))#checksum
// ───────────────────────────────────────────────────────────────────────────

const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}" +
  "IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~" +
  "ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";

function polymod(c: bigint, val: number): bigint {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  if (c0 & 1n) c ^= 0xf5dee51989n;
  if (c0 & 2n) c ^= 0xa9fdca3312n;
  if (c0 & 4n) c ^= 0x1bab10e32dn;
  if (c0 & 8n) c ^= 0x3706b1677an;
  if (c0 & 16n) c ^= 0x644d626ffdn;
  return c;
}

/** BIP380 描述符校验和。抄错一个字符即可被检出。 */
export function descriptorChecksum(desc: string): string {
  let c = 1n;
  let cls = 0;
  let clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new Error(`Invalid descriptor character: ${JSON.stringify(ch)}`);
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) {
      c = polymod(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; j++) c = polymod(c, 0);
  c ^= 1n;

  let out = "";
  for (let j = 0; j < 8; j++) {
    out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
  }
  return out;
}

export function appendChecksum(desc: string): string {
  return `${desc}#${descriptorChecksum(desc)}`;
}

export function verifyChecksum(descWithChecksum: string): boolean {
  const idx = descWithChecksum.lastIndexOf("#");
  if (idx === -1) return false;
  const body = descWithChecksum.slice(0, idx);
  const given = descWithChecksum.slice(idx + 1);
  try {
    const expected = descriptorChecksum(body);
    return constantTimeEqual(
      new TextEncoder().encode(expected),
      new TextEncoder().encode(given),
    );
  } catch {
    return false;
  }
}

/** BIP380 用 `h` 表示硬化；部分工具用 `'`。统一成 `h` 便于抄写。 */
function normalizeHardened(path: string): string {
  return path.replace(/'/g, "h");
}

function keyExpression(cosigner: Cosigner, branch: "multipath" | 0 | 1): string {
  const origin = `[${cosigner.fingerprint.toLowerCase()}${normalizeHardened(
    cosigner.derivationPath.replace(/^m/, ""),
  )}]`;
  const suffix = branch === "multipath" ? "/<0;1>/*" : `/${branch}/*`;
  // 规范化成 xpub/tpub：BIP380 里 wsh() 的规范序列化是 xpub，原样写 zpub 时
  // Sparrow 能容忍但 Bitcoin Core 直接拒绝导入。描述符是多签唯一的恢复路径，
  // 不能让它在一半的软件里打不开。
  const canonical = toCanonicalExtPubKey(cosigner.xpub, getNetworkModeSync());
  return `${origin}${canonical}${suffix}`;
}

// ── key expression 解析（创建金库时接受协签方粘贴的完整表达式）──

const KEY_EXPRESSION_RE = /^\[([0-9a-fA-F]{8})((?:\/\d+[h'H]?)*)\]([a-zA-Z0-9]+)(?:\/(?:<0;1>|[01])\/\*)?$/;

export type ParsedKeyExpression = {
  xpub: string;
  /** master fingerprint（8 位 hex）。裸 xpub 输入时为 null。 */
  fingerprint: string | null;
  /** key origin 派生路径。裸 xpub 输入时为 null。 */
  derivationPath: string | null;
};

/**
 * 解析协签方输入。接受两种形式：
 *   1. 完整 key expression：`[f0e1d2c3/48h/0h/0h/2h]xpub6.../<0;1>/*`
 *      —— Coldcard / Sparrow / Keystone / Passport 的标准导出格式
 *   2. 裸 xpub（兼容旧输入，但 fingerprint / path 返回 null）
 *
 * 【为什么必须支持形式 1】master fingerprint **无法从 account 级 xpub 推导**。
 * 旧实现用 `parseExtKey(xpub).fingerprint` 填 master fingerprint，那取到的是
 * account 节点自身的指纹（hash160(自己的 pubkey)），不是 master。结果是导出的
 * 描述符与 PSBT 里的 key origin 全是错的，对端硬件钱包认不出这是自己的输入，
 * 协签和恢复都会失败。指纹只能由用户从设备上一并带过来。
 */
export function parseKeyExpression(raw: string): ParsedKeyExpression {
  const trimmed = raw.trim();
  const m = trimmed.match(KEY_EXPRESSION_RE);
  if (m) {
    const [, fingerprint, originPath, xpub] = m;
    parseExtKey(xpub); // publicOnly 默认 true —— xprv 在这里就被拦下
    return {
      xpub,
      fingerprint: fingerprint.toLowerCase(),
      derivationPath: `m${normalizeHardened(originPath).replace(/h/g, "'")}`,
    };
  }
  // 裸扩展公钥
  parseExtKey(trimmed);
  return { xpub: trimmed, fingerprint: null, derivationPath: null };
}

/** UI 即时校验：输入是否是**带 key origin** 的完整 key expression。 */
export function isValidKeyExpression(raw: string): boolean {
  try {
    const p = parseKeyExpression(raw);
    return Boolean(p.fingerprint && p.derivationPath);
  } catch {
    return false;
  }
}

/**
 * 把本机 cosigner 序列化成给对方设备用的完整 key expression。
 *
 * 旧的 handleCopyXpub 只复制裸 xpub —— 对端拿到后同样凑不出 key origin，
 * 问题在两台设备上是对称的。必须连 master fingerprint 和派生路径一起给出去。
 */
export function selfKeyExpression(cosigner: Cosigner): string {
  if (!/^[0-9a-fA-F]{8}$/.test(cosigner.fingerprint)) {
    throw new Error("Cosigner is missing a master fingerprint");
  }
  const origin = `[${cosigner.fingerprint.toLowerCase()}${normalizeHardened(
    cosigner.derivationPath.replace(/^m/, ""),
  )}]`;
  return `${origin}${toCanonicalExtPubKey(cosigner.xpub, getNetworkModeSync())}`;
}

export type DescriptorForm = {
  /** 单行 multipath 形式（Sparrow / Bitcoin Core 24+ 支持）。 */
  multipath: string;
  /** 收款链描述符。 */
  receive: string;
  /** 找零链描述符。 */
  change: string;
};

export function buildVaultDescriptor(vault: VaultConfig): DescriptorForm {
  assertDescriptorSafe(vault);
  const make = (branch: "multipath" | 0 | 1) =>
    appendChecksum(
      `wsh(sortedmulti(${vault.m},${vault.cosigners
        .map((c) => keyExpression(c, branch))
        .join(",")}))`,
    );
  return { multipath: make("multipath"), receive: make(0), change: make(1) };
}

// ── 导入 ──

const DESCRIPTOR_RE =
  /^wsh\(sortedmulti\((\d+),(.+)\)\)$/;
const KEY_RE =
  /^\[([0-9a-fA-F]{8})((?:\/\d+[h']?)*)\]([a-zA-Z0-9]+)(\/(?:<0;1>|[01])\/\*)?$/;

export type ParsedDescriptor = {
  m: number;
  cosigners: Array<{ fingerprint: string; derivationPath: string; xpub: string }>;
};

/** 按顶层逗号切分（不切括号内的）。 */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of input) {
    if (ch === "(" || ch === "[" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === ">") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseVaultDescriptor(input: string): ParsedDescriptor {
  const trimmed = input.trim();
  const hashIdx = trimmed.lastIndexOf("#");
  if (hashIdx !== -1 && !verifyChecksum(trimmed)) {
    throw new Error("Descriptor checksum mismatch — the text was mistyped or corrupted");
  }
  const body = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);

  const m = body.match(DESCRIPTOR_RE);
  if (!m) throw new Error("Unsupported descriptor: expected wsh(sortedmulti(...))");

  const threshold = Number.parseInt(m[1], 10);
  const keys = splitTopLevel(m[2]);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) {
    throw new Error(`Invalid threshold ${m[1]} for ${keys.length} keys`);
  }

  const cosigners = keys.map((raw) => {
    const km = raw.trim().match(KEY_RE);
    if (!km) throw new Error(`Unparseable key expression: ${raw.trim().slice(0, 24)}…`);
    const [, fingerprint, originPath, xpub] = km;
    parseExtKey(xpub); // 校验可解析
    return {
      fingerprint: fingerprint.toLowerCase(),
      derivationPath: `m${normalizeHardened(originPath).replace(/h/g, "'")}`,
      xpub,
    };
  });

  return { m: threshold, cosigners };
}

// ── 安全前置校验 ──

export class DuplicateCosignerError extends Error {
  constructor(public readonly kind: "xpub" | "fingerprint") {
    super(`Duplicate cosigner ${kind}`);
  }
}

/**
 * 归一化扩展公钥用于去重比较。
 *
 * 必须先解析再比较：同一把密钥的 xpub / zpub / Zpub / tpub 字符串不同但等价，
 * 直接比字符串会漏掉重复。
 */
export function normalizedKeyId(xpub: string): string {
  const node = parseExtKey(xpub);
  if (!node.publicKey) throw new Error("Extended key has no public key");
  const pub = Array.from(node.publicKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const chain = Array.from(node.chainCode ?? new Uint8Array())
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${pub}:${chain}`;
}

/**
 * 重复协签方检查。
 *
 * 【为什么必须有】旧的 VaultCreateScreen 只校验每个 xpub 格式合法，**完全没有
 * 去重**。用户把同一个 xpub 粘进 2-of-3 的两个外部槽位（复制粘贴时极易发生），
 * 得到的 vault 里有两把相同密钥 → 持有那把密钥的一方可以单独凑齐 2 个签名花掉
 * 全部资金。而 sortedMultisig 会正常接受重复 pubkey，地址能生成、交易能签、
 * 链上有效——**不会有任何报错**，用户完全无感。
 */
export function assertNoDuplicateCosigners(cosigners: Pick<Cosigner, "xpub" | "fingerprint">[]): void {
  const keyIds = cosigners.map((c) => normalizedKeyId(c.xpub));
  if (new Set(keyIds).size !== keyIds.length) throw new DuplicateCosignerError("xpub");

  const fps = cosigners.map((c) => c.fingerprint.toLowerCase()).filter(Boolean);
  if (new Set(fps).size !== fps.length) throw new DuplicateCosignerError("fingerprint");
}

/** P2WSH 裸多签受 OP_1..OP_16 限制，最多 15 把密钥。 */
export const MAX_COSIGNERS = 15;

export function assertDescriptorSafe(vault: Pick<VaultConfig, "m" | "n" | "cosigners" | "scriptType">): void {
  if (vault.scriptType !== "p2wsh") throw new Error(`Unsupported script type: ${vault.scriptType}`);
  const n = vault.cosigners.length;
  if (n !== vault.n) throw new Error(`Cosigner count ${n} does not match n=${vault.n}`);
  if (!Number.isInteger(vault.m) || vault.m < 1) throw new Error(`Invalid threshold m=${vault.m}`);
  if (vault.m > n) throw new Error(`Threshold m=${vault.m} exceeds cosigner count ${n}`);
  if (n > MAX_COSIGNERS) throw new Error(`P2WSH multisig supports at most ${MAX_COSIGNERS} keys`);
  assertNoDuplicateCosigners(vault.cosigners);
  const network = getNetworkModeSync();
  for (const c of vault.cosigners) {
    if (!/^[0-9a-fA-F]{8}$/.test(c.fingerprint)) {
      throw new Error(`Invalid master fingerprint: ${c.fingerprint}`);
    }
    parseBip32Path(c.derivationPath); // 路径可解析
    // 扩展**私钥**绝不能进 vault：cosigner.xpub 会被原样写进导出的 output
    // descriptor，而用户被要求把描述符打印/拍照/抄纸备份。
    const info = inspectExtKey(c.xpub);
    if (info.isPrivate) throw new PrivateKeyNotAllowedError();
    // 跨网络协签方：派生能跑通（版本字节不参与派生），但导出的描述符在对端
    // 不可用，且地址树与本机不一致。必须在入库前拦住。
    if (info.network !== network) {
      throw new Error(
        `Cosigner ${c.name || c.fingerprint} is a ${info.network} key (${info.label}) but the wallet is in ${network} mode`,
      );
    }
  }
}

export { pathToString };
