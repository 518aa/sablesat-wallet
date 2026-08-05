import ExpoCryptoNative from "expo-crypto/build/ExpoCrypto";

// ───────────────────────────────────────────────────────────────────────────
// 统一熵源。**钱包里唯一允许产生随机数的地方。**
//
// 【为什么不能直接用 expo-crypto 的 getRandomBytes】
// expo-crypto 的**同步** getRandomBytes 有一段静默降级逻辑：
//
//     if (__DEV__) {
//       if (!global.nativeCallSyncHook || global.__REMOTEDEV__) {
//         // remote javascript debugging is enabled
//         for (...) array[i] = Math.floor(Math.random() * 256);   // ← !!
//         return array;
//       }
//     }
//
// 也就是说：**开发构建 + 调试器 attach 时，助记词的熵会退化成 Math.random()**。
// Hermes / V8 的 Math.random 是 xorshift128+，约 2 个输出即可还原内部状态 ——
// 在那个状态下创建的钱包，助记词可被直接逆推。
//
// 生产构建（__DEV__ === false）不受影响，但开发者在调试时创建的测试钱包会中招，
// 而且这类"看起来正常工作"的降级最危险 —— 随机数看上去仍然是随机的。
//
// 本模块的做法：
//   1. 显式检测降级条件，命中即 **hard-fail**，绝不静默产出弱随机
//   2. 优先用 react-native-quick-crypto（JSI → OpenSSL CSPRNG）
//   3. 否则**直接调用原生模块** ExpoCrypto.getRandomValues，绕过上面那段 JS 逻辑
//   4. 提供异步变体（getRandomBytesAsync 本身没有该降级分支）
// ───────────────────────────────────────────────────────────────────────────

export class WeakEntropyError extends Error {
  constructor(public readonly reason: string) {
    super(
      `Refusing to generate key material with degraded entropy: ${reason}. ` +
        `Disable remote JS debugging, or use a release build.`,
    );
  }
}

type QuickCryptoRandom = { randomFillSync?: (buf: Uint8Array) => Uint8Array };

let quick: QuickCryptoRandom | null = null;
let quickProbed = false;

function getQuick(): QuickCryptoRandom | null {
  if (quickProbed) return quick;
  quickProbed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("react-native-quick-crypto") as { default?: QuickCryptoRandom } & QuickCryptoRandom;
    const impl = mod.default ?? mod;
    if (typeof impl?.randomFillSync === "function") quick = impl;
  } catch {
    quick = null;
  }
  return quick;
}

/**
 * 检测 expo-crypto 会走 Math.random 分支的条件。
 * 与 expo-crypto 源码里的判断保持一致。
 */
export function isEntropyDegraded(): { degraded: boolean; reason: string } {
  if (typeof __DEV__ === "undefined" || !__DEV__) return { degraded: false, reason: "" };
  const g = globalThis as unknown as { nativeCallSyncHook?: unknown; __REMOTEDEV__?: unknown };
  if (g.__REMOTEDEV__) return { degraded: true, reason: "remote JS debugging (__REMOTEDEV__)" };
  if (!g.nativeCallSyncHook) return { degraded: true, reason: "JSI bridge unavailable (debugger attached)" };
  return { degraded: false, reason: "" };
}

/**
 * 密码学安全随机字节。所有密钥材料（助记词熵、DEK、salt、nonce、device secret）
 * 都必须经由此函数。
 *
 * @throws WeakEntropyError 熵源可能已降级时直接抛错，绝不返回弱随机
 */
export function secureRandomBytes(byteLength: number): Uint8Array {
  if (!Number.isInteger(byteLength) || byteLength <= 0 || byteLength > 65536) {
    throw new RangeError(`Invalid byteLength: ${byteLength}`);
  }

  // 原生 OpenSSL CSPRNG（若可用）——不受 expo-crypto 那段 JS 降级影响
  const q = getQuick();
  if (q?.randomFillSync) {
    return q.randomFillSync(new Uint8Array(byteLength));
  }

  // 回退到 Expo 原生模块。先确认没有落进降级条件。
  const { degraded, reason } = isEntropyDegraded();
  if (degraded) throw new WeakEntropyError(reason);

  const out = new Uint8Array(byteLength);
  // 注意：这里调的是**原生模块方法**，不是 expo-crypto 导出的 getRandomBytes()——
  // 后者带有 Math.random 降级分支。
  const native = ExpoCryptoNative as { getRandomValues?: (a: Uint8Array) => void };
  if (typeof native?.getRandomValues !== "function") {
    throw new WeakEntropyError("ExpoCrypto native module unavailable");
  }
  native.getRandomValues(out);

  if (out.every((b) => b === 0)) {
    throw new WeakEntropyError("native RNG returned all zeros");
  }
  return out;
}

/** 异步变体。expo-crypto 的 getRandomBytesAsync 本身没有降级分支。 */
export async function secureRandomBytesAsync(byteLength: number): Promise<Uint8Array> {
  return secureRandomBytes(byteLength);
}

// ── 启动自检 ──

/**
 * 熵源健康自检。
 *
 * 注意：**统计检验发现不了 Math.random** —— 它的输出看起来完全正常
 * （非零、不重复、分布均匀）。所以这里的核心是**结构性检查**（降级条件、
 * 熵源可用性），统计检查只作为"RNG 彻底坏掉"的兜底。
 */
export function assertEntropyHealthy(): void {
  const { degraded, reason } = isEntropyDegraded();
  if (degraded && !getQuick()) throw new WeakEntropyError(reason);

  // 兜底：卡死的 RNG（全 0 / 常量 / 两次相同）
  const a = secureRandomBytes(32);
  const b = secureRandomBytes(32);
  if (a.every((x) => x === 0)) throw new WeakEntropyError("all zeros");
  if (a.every((x) => x === a[0])) throw new WeakEntropyError("constant output");
  if (a.every((x, i) => x === b[i])) throw new WeakEntropyError("two draws identical");

  // 极弱的字节多样性检查：32 字节里独立值少于 8 个基本不可能（概率 < 2^-40）
  if (new Set(a).size < 8) throw new WeakEntropyError("suspiciously low byte diversity");
}

/** 供设置页诊断展示：当前实际使用的熵源。 */
export function describeEntropySource(): string {
  if (getQuick()) return "react-native-quick-crypto (OpenSSL CSPRNG)";
  const { degraded, reason } = isEntropyDegraded();
  if (degraded) return `DEGRADED: ${reason}`;
  return "ExpoCrypto native (SecRandomCopyBytes / SecureRandom)";
}
