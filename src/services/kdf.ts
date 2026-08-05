// KDF 抽象层：优先走 react-native-quick-crypto（JSI → OpenSSL，比 Hermes 上的
// 纯 JS 实现快 20-100×），不可用时（Expo Go / Web / 测试环境）回退 @noble。
//
// 两条实现必须产出逐字节一致的结果 —— 见 src/__tests__/kdfParity.test.ts。
// 若不一致，用户在 Expo Go 里创建的钱包会在正式包里解不开。
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scryptAsync as nobleScryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { logger } from "./logger";

export type ScryptParams = { N: number; r: number; p: number };

const SCRYPT_MAX_MEM = 128 * 1024 * 1024;

type QuickCrypto = {
  pbkdf2: (
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    cb: (err: Error | null, key: Uint8Array) => void,
  ) => void;
  scrypt: (
    password: Uint8Array,
    salt: Uint8Array,
    keylen: number,
    opts: { N: number; r: number; p: number; maxmem: number },
    cb: (err: Error | null, key: Uint8Array) => void,
  ) => void;
};

let native: QuickCrypto | null = null;
let nativeProbed = false;

function getNative(): QuickCrypto | null {
  if (nativeProbed) return native;
  nativeProbed = true;
  try {
    // 动态 require：Expo Go / jest 下模块不存在时静默回退，不影响启动。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-quick-crypto") as { default?: QuickCrypto } & QuickCrypto;
    const impl = mod.default ?? mod;
    if (typeof impl?.pbkdf2 === "function" && typeof impl?.scrypt === "function") {
      native = impl;
      logger.info("KDF: using react-native-quick-crypto (native)");
    }
  } catch {
    logger.info("KDF: native module unavailable, falling back to @noble (JS)");
  }
  return native;
}

/** 当前是否在用原生实现（供设置页诊断信息展示）。 */
export function isNativeKdfActive(): boolean {
  return getNative() !== null;
}

export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Promise<Uint8Array> {
  const impl = getNative();
  if (impl) {
    return new Promise((resolve, reject) => {
      impl.pbkdf2(password, salt, iterations, dkLen, "sha256", (err, key) =>
        err ? reject(err) : resolve(new Uint8Array(key)),
      );
    });
  }
  // asyncTick 让出 JS 线程，保证进度指示器能动。
  return pbkdf2Async(sha256, password, salt, { c: iterations, dkLen, asyncTick: 10 });
}

export async function scryptKdf(
  password: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams,
  dkLen: number,
): Promise<Uint8Array> {
  const impl = getNative();
  if (impl) {
    return new Promise((resolve, reject) => {
      impl.scrypt(
        password,
        salt,
        dkLen,
        { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAX_MEM },
        (err, key) => (err ? reject(err) : resolve(new Uint8Array(key))),
      );
    });
  }
  // 用 scryptAsync 而非同步 scrypt：同步版本会独占 JS 线程直到算完，
  // 转圈动画整个过程是冻住的（用户感知为"卡死"），且有 Android ANR 风险。
  // 实测代价仅 +20ms。
  return nobleScryptAsync(password, salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen,
    maxmem: SCRYPT_MAX_MEM,
    asyncTick: 10,
  });
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

// ───────────────────────────────────────────────────────────────────────────
// 设备上的原生 / JS 一致性自检
//
// ⚠️ `npm run test:kdf-parity`（jest）**验证不了这件事**：Node 环境里
// react-native-quick-crypto 加载不了，isNativeKdfActive() 恒为 false，
// 那个测试比的是「@noble 对 @noble」。原生分支只能在真机上验。
//
// 为什么必须验：两条实现若对同一输入产出不同结果，用一条路径创建的钱包
// 在另一条路径下就解不开 —— 换机、升级、原生模块加载失败都会触发切换，
// 直接导致资产无法找回。
// ───────────────────────────────────────────────────────────────────────────

export type KdfParityResult = {
  nativeAvailable: boolean;
  /** 原生不可用时为 null（此时只有一条实现，不存在分歧）。 */
  match: boolean | null;
  scryptMatch: boolean | null;
  pbkdf2Match: boolean | null;
  elapsedMs: number;
  detail: string;
};

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * 用固定测试向量分别跑原生与 JS，比对逐字节结果。
 * 参数取小值（N=1024）以便快速执行，KDF 的一致性与 N 大小无关。
 */
export async function checkKdfParity(): Promise<KdfParityResult> {
  const t0 = Date.now();
  const n = getNative();
  if (!n) {
    return {
      nativeAvailable: false,
      match: null,
      scryptMatch: null,
      pbkdf2Match: null,
      elapsedMs: Date.now() - t0,
      detail: "原生 KDF 未启用，仅有 @noble 一条实现，不存在分歧风险",
    };
  }

  const pw = new TextEncoder().encode("parity-check-vector");
  const salt = new Uint8Array(16).map((_, i) => (i * 17 + 3) & 0xff);
  const params: ScryptParams = { N: 1024, r: 8, p: 1 };

  // scrypt：原生 vs JS
  const nativeScrypt = await new Promise<Uint8Array>((res, rej) =>
    n.scrypt(pw, salt, 32, { ...params, maxmem: SCRYPT_MAX_MEM }, (e, k) => (e ? rej(e) : res(k))),
  );
  const jsScrypt = await nobleScryptAsync(pw, salt, { ...params, dkLen: 32, maxmem: SCRYPT_MAX_MEM });
  const scryptMatch = toHex(nativeScrypt) === toHex(jsScrypt);

  // pbkdf2：原生 vs JS
  const nativePbkdf2 = await new Promise<Uint8Array>((res, rej) =>
    n.pbkdf2(pw, salt, 1000, 32, "sha256", (e, k) => (e ? rej(e) : res(k))),
  );
  const jsPbkdf2 = await pbkdf2Async(sha256, pw, salt, { c: 1000, dkLen: 32 });
  const pbkdf2Match = toHex(nativePbkdf2) === toHex(jsPbkdf2);

  const match = scryptMatch && pbkdf2Match;
  if (!match) {
    // 不打印密钥本身，只记录哪一项不一致
    logger.error("KDF parity FAILED", { scryptMatch, pbkdf2Match });
  }
  return {
    nativeAvailable: true,
    match,
    scryptMatch,
    pbkdf2Match,
    elapsedMs: Date.now() - t0,
    detail: match
      ? "原生与 JS 实现逐字节一致"
      : `不一致：scrypt=${scryptMatch ? "一致" : "不一致"} pbkdf2=${pbkdf2Match ? "一致" : "不一致"}`,
  };
}

/** 一致性校验缓存：每次冷启动验一次即可。 */
let parityCache: KdfParityResult | null = null;

export async function ensureKdfParity(): Promise<KdfParityResult> {
  if (!parityCache) parityCache = await checkKdfParity();
  return parityCache;
}

export class KdfParityError extends Error {
  constructor(public readonly result: KdfParityResult) {
    super(`KDF implementations disagree: ${result.detail}`);
  }
}

/**
 * 创建 / 导入钱包前必须调用。
 * 两条实现不一致时拒绝创建 —— 此时创建出的钱包在实现切换后将无法解开。
 */
export async function assertKdfParityOk(): Promise<void> {
  const r = await ensureKdfParity();
  if (r.match === false) throw new KdfParityError(r);
}
