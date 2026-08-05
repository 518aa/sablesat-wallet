// 安全策略执行点的穷尽性测试（根因 2 的运行时那一半）。
//
// 编译期那一半在 security.ts：POLICY_ENFORCEMENT 是
// Record<keyof SecurityPolicy, ...>，新增策略字段却不登记执行点 → 编译失败。
//
// 这里验证的是**登记的执行点真的会拦**。一个只有登记表、执行点却是空函数的
// 实现同样能通过编译 —— 那正是本次审计发现的两个字段的原型。

import {
  POLICY_ENFORCEMENT,
  getSecurityPolicy,
  assertSendAllowed,
  assertExportAllowed,
  assertKeyGenerationAllowed,
  needsRiskAcknowledgement,
  needsBiometricForTransaction,
  SecurityPolicyError,
  __setSecurityStateForTests,
  __resetSecurityCache,
  type DeviceSecurityState,
} from "../services/security";

function fakeState(overrides: Partial<DeviceSecurityState> = {}): DeviceSecurityState {
  return {
    level: "danger",
    isDebug: false,
    isExpoGo: false,
    isStandalone: true,
    isEmulator: false,
    isJailBroken: true,
    isHooked: false,
    entropyDegraded: false,
    entropySource: "test",
    platform: "test",
    warnings: [{ level: "danger", code: "jailbroken", messageKey: "securityWarnJailbroken" }],
    ...overrides,
  };
}

afterEach(() => {
  __resetSecurityCache();
});

describe("策略字段与执行点一一对应", () => {
  it("每个 SecurityPolicy 字段都登记了执行点", () => {
    __setSecurityStateForTests(fakeState({ level: "ok", isJailBroken: false, warnings: [] }));
    const policy = getSecurityPolicy();
    for (const key of Object.keys(policy)) {
      expect(POLICY_ENFORCEMENT).toHaveProperty(key);
      expect(POLICY_ENFORCEMENT[key as keyof typeof POLICY_ENFORCEMENT].enforcedBy).toBeTruthy();
    }
  });

  it("登记表里没有多余条目（策略字段被删了但登记忘了删）", () => {
    __setSecurityStateForTests(fakeState({ level: "ok", isJailBroken: false, warnings: [] }));
    const policyKeys = new Set(Object.keys(getSecurityPolicy()));
    for (const key of Object.keys(POLICY_ENFORCEMENT)) {
      expect(policyKeys.has(key)).toBe(true);
    }
  });
});

describe("danger 环境下执行点真的会拦", () => {
  it("maxSendSats：超额发送被拒", () => {
    __setSecurityStateForTests(fakeState());
    const limit = getSecurityPolicy().maxSendSats;
    expect(limit).not.toBeNull();
    expect(() => assertSendAllowed(limit! + 1, true)).toThrow(SecurityPolicyError);
  });

  it("requireBiometricPerTransaction：未经生物识别确认的发送被拒", () => {
    // 这条曾经是**纯声明**：字段存在、文档写了、代码里零引用。
    __setSecurityStateForTests(fakeState());
    expect(needsBiometricForTransaction()).toBe(true);
    expect(() => assertSendAllowed(1000, false)).toThrow(SecurityPolicyError);
    expect(() => assertSendAllowed(1000, true)).not.toThrow();
  });

  it("allowSecretExport：导出被拒", () => {
    __setSecurityStateForTests(fakeState());
    expect(() => assertExportAllowed()).toThrow(SecurityPolicyError);
  });

  it("allowKeyGeneration：熵源降级时禁止生成新密钥", () => {
    __setSecurityStateForTests(fakeState({ entropyDegraded: true }));
    expect(() => assertKeyGenerationAllowed()).toThrow(SecurityPolicyError);
  });

  it("allowKeyGeneration：仅越狱（熵源正常）时仍允许生成", () => {
    // 分级降权而非一刀切：越狱设备上熵源本身没问题，堵死生成只会逼用户去绕过检测。
    __setSecurityStateForTests(fakeState({ entropyDegraded: false }));
    expect(() => assertKeyGenerationAllowed()).not.toThrow();
  });

  it("requireRiskAcknowledgement：需要风险确认", () => {
    // 同样曾经是纯声明。
    __setSecurityStateForTests(fakeState());
    expect(needsRiskAcknowledgement()).toBe(true);
  });
});

describe("ok 环境下不做任何多余限制", () => {
  beforeEach(() => {
    __setSecurityStateForTests(fakeState({ level: "ok", isJailBroken: false, warnings: [] }));
  });

  it("发送、导出、生成全部放行", () => {
    expect(() => assertSendAllowed(100_000_000, false)).not.toThrow();
    expect(() => assertExportAllowed()).not.toThrow();
    expect(() => assertKeyGenerationAllowed()).not.toThrow();
    expect(needsRiskAcknowledgement()).toBe(false);
    expect(needsBiometricForTransaction()).toBe(false);
  });
});
