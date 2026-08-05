/**
 * 熵源回归测试。
 *
 * 背景：expo-crypto 的**同步** getRandomBytes 在 `__DEV__ && (!nativeCallSyncHook
 * || __REMOTEDEV__)` 时会静默退化成 Math.random()。旧代码用它生成助记词熵、
 * device secret、salt 和 nonce —— 在调试器 attach 的开发构建里创建的钱包，
 * 助记词可被逆推（Hermes/V8 的 Math.random 是 xorshift128+）。
 *
 * 关键点：**统计检验发现不了这个问题** —— Math.random 的输出非零、不重复、
 * 分布均匀，看起来完全正常。所以必须做结构性检测。
 */

type Env = { dev: boolean; jsi: boolean; remotedev: boolean };

function setEnv({ dev, jsi, remotedev }: Env) {
  (globalThis as Record<string, unknown>).__DEV__ = dev;
  (globalThis as Record<string, unknown>).nativeCallSyncHook = jsi ? {} : undefined;
  (globalThis as Record<string, unknown>).__REMOTEDEV__ = remotedev ? {} : undefined;
}

const nativeBytes = jest.fn((a: Uint8Array) => {
  for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256;
});

jest.mock("expo-crypto/build/ExpoCrypto", () => ({
  __esModule: true,
  default: { getRandomValues: (a: Uint8Array) => nativeBytes(a) },
}));

// quick-crypto 在测试环境不可用，强制走 Expo 原生分支
jest.mock("react-native-quick-crypto", () => {
  throw new Error("not available in tests");
});

function freshModule() {
  let mod!: typeof import("../services/randomness");
  jest.isolateModules(() => {
    mod = require("../services/randomness");
  });
  return mod;
}

describe("entropy source hardening", () => {
  afterEach(() => jest.clearAllMocks());

  it("does not flag a release build", () => {
    setEnv({ dev: false, jsi: true, remotedev: false });
    const m = freshModule();
    expect(m.isEntropyDegraded().degraded) .toBe(false);
    expect(m.secureRandomBytes(32)).toHaveLength(32);
  });

  it("does not flag a dev build on a real device with JSI", () => {
    setEnv({ dev: true, jsi: true, remotedev: false });
    const m = freshModule();
    expect(m.isEntropyDegraded().degraded).toBe(false);
  });

  it("REGRESSION: refuses to produce key material under remote JS debugging", () => {
    setEnv({ dev: true, jsi: true, remotedev: true });
    const m = freshModule();
    expect(m.isEntropyDegraded().degraded).toBe(true);
    expect(() => m.secureRandomBytes(32)).toThrow(m.WeakEntropyError);
  });

  it("REGRESSION: refuses to produce key material when the JSI bridge is gone", () => {
    setEnv({ dev: true, jsi: false, remotedev: false });
    const m = freshModule();
    expect(m.isEntropyDegraded().degraded).toBe(true);
    expect(() => m.secureRandomBytes(32)).toThrow(m.WeakEntropyError);
  });

  it("rejects an all-zero native RNG", () => {
    setEnv({ dev: false, jsi: true, remotedev: false });
    nativeBytes.mockImplementationOnce((a: Uint8Array) => a.fill(0));
    const m = freshModule();
    expect(() => m.secureRandomBytes(32)).toThrow(/all zeros/);
  });

  it("startup self-check fails in a degraded environment", () => {
    setEnv({ dev: true, jsi: false, remotedev: false });
    const m = freshModule();
    expect(() => m.assertEntropyHealthy()).toThrow(m.WeakEntropyError);
  });

  it("describeEntropySource surfaces the degraded reason", () => {
    setEnv({ dev: true, jsi: true, remotedev: true });
    const m = freshModule();
    expect(m.describeEntropySource()).toMatch(/^DEGRADED/);
  });
});
