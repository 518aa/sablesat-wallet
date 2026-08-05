import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import { logger } from "./logger";
import { isEntropyDegraded, describeEntropySource } from "./randomness";

// ───────────────────────────────────────────────────────────────────────────
// 设备安全状态检测。
//
// 定位很重要：**这是风险信号，不是安全边界。** 客户端越狱检测在有动机的攻击者
// 面前必然失效（Shadow / Liberty Lite / Frida 都能 hook 掉这些检查）。真正的
// 安全边界建在硬件上——见 vaultKey.ts 的 requireAuthentication + Secure Enclave。
//
// 与旧实现的差异：
//   1. 旧版只查 __DEV__ 和 Expo Go，连模拟器都不查（模拟器上 Keychain 是明文文件）
//   2. 旧版结论只用于渲染一个横幅，完全不接入业务逻辑；现在 danger 级会真正
//      收紧签名与导出策略（见 getSecurityPolicy）
//   3. 不做「检测到 root 就阻断启动」——那只会促使用户去装 Magisk Hide 绕过，
//      结果是连信号本身都失去了。改为分级降权。
// ───────────────────────────────────────────────────────────────────────────

export type SecurityLevel = "ok" | "warn" | "danger";

export type SecurityWarningCode =
  | "debug-build"
  | "expo-go"
  | "emulator"
  | "jailbroken"
  | "hooked"
  | "dev-settings"
  | "external-storage"
  | "weak-entropy";

export type SecurityWarning = {
  level: SecurityLevel;
  code: SecurityWarningCode;
  messageKey: string;
};

export type DeviceSecurityState = {
  level: SecurityLevel;
  isDebug: boolean;
  isExpoGo: boolean;
  isStandalone: boolean;
  isEmulator: boolean;
  isJailBroken: boolean;
  isHooked: boolean;
  /** 熵源是否已降级（expo-crypto 在调试器下会退化到 Math.random）。 */
  entropyDegraded: boolean;
  entropySource: string;
  platform: string;
  warnings: SecurityWarning[];
};

type JailMonkey = {
  isJailBroken: () => boolean;
  hookDetected?: () => boolean;
  isDebuggedMode?: () => Promise<boolean> | boolean;
  isDevelopmentSettingsMode?: () => Promise<boolean> | boolean;
  isOnExternalStorage?: () => boolean;
};

let jailMonkey: JailMonkey | null = null;
let probed = false;

function getJailMonkey(): JailMonkey | null {
  if (probed) return jailMonkey;
  probed = true;
  try {
    // 动态 require：Expo Go / jest 下模块不存在时静默跳过。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("jail-monkey") as { default?: JailMonkey } & JailMonkey;
    jailMonkey = mod.default ?? mod;
  } catch {
    logger.info("jail-monkey unavailable (Expo Go or test env)");
  }
  return jailMonkey;
}

/** Frida 常见痕迹。同样可被绕过，但能挡住直接套用现成脚本的一类攻击者。 */
function detectInstrumentation(): boolean {
  try {
    const g = globalThis as Record<string, unknown>;
    if (typeof g.Frida !== "undefined" || typeof g.Java !== "undefined") return true;
    if (typeof g.__REMOTEDEV__ !== "undefined") return true;
    const jm = getJailMonkey();
    if (jm?.hookDetected?.()) return true;
  } catch {
    /* 探测失败按未检出处理 */
  }
  return false;
}

let cached: DeviceSecurityState | null = null;

export function getDeviceSecurityState(): DeviceSecurityState {
  if (cached) return cached;

  const isDebug = Boolean(__DEV__);
  const isStandalone = Constants.executionEnvironment === ExecutionEnvironment.Standalone;
  const isExpoGo = Constants.appOwnership === "expo";
  const isEmulator = Device.isDevice === false;

  const jm = getJailMonkey();
  let isJailBroken = false;
  try {
    isJailBroken = jm?.isJailBroken() ?? false;
  } catch {
    isJailBroken = false;
  }
  const isHooked = detectInstrumentation();
  const entropy = isEntropyDegraded();

  const warnings: SecurityWarning[] = [];
  // 熵源降级是最高优先级的告警：在这个状态下创建的钱包助记词可被逆推。
  // 注意 randomness.secureRandomBytes 已经会 hard-fail，这里只是让用户看到原因。
  if (entropy.degraded) {
    warnings.push({ level: "danger", code: "weak-entropy", messageKey: "securityWarnWeakEntropy" });
  }
  if (isExpoGo) warnings.push({ level: "danger", code: "expo-go", messageKey: "securityWarnExpoGo" });
  if (isEmulator) warnings.push({ level: "danger", code: "emulator", messageKey: "securityWarnEmulator" });
  if (isJailBroken) warnings.push({ level: "danger", code: "jailbroken", messageKey: "securityWarnJailbroken" });
  if (isHooked) warnings.push({ level: "danger", code: "hooked", messageKey: "securityWarnHooked" });
  if (isDebug) warnings.push({ level: "warn", code: "debug-build", messageKey: "securityWarnDebug" });
  try {
    if (jm?.isOnExternalStorage?.()) {
      warnings.push({ level: "warn", code: "external-storage", messageKey: "securityWarnExternalStorage" });
    }
  } catch {
    /* 可选检测，失败忽略 */
  }

  const level: SecurityLevel = warnings.some((w) => w.level === "danger")
    ? "danger"
    : warnings.some((w) => w.level === "warn")
      ? "warn"
      : "ok";

  cached = {
    level,
    isDebug,
    isExpoGo,
    isStandalone,
    isEmulator,
    isJailBroken,
    isHooked,
    entropyDegraded: entropy.degraded,
    entropySource: describeEntropySource(),
    platform: `${Platform.OS} ${Platform.Version}`,
    warnings,
  };
  return cached;
}

// ── 分级策略：把检测结论真正接进业务逻辑 ──

export type SecurityPolicy = {
  /** 是否允许生成新助记词。熵源降级时必须为 false。 */
  allowKeyGeneration: boolean;
  /** 每笔交易强制生物识别（不接受仅 PIN）。 */
  requireBiometricPerTransaction: boolean;
  /** 单笔发送上限（sats）；null 表示不限。 */
  maxSendSats: number | null;
  /** 是否允许明文导出助记词 / 私钥。 */
  allowSecretExport: boolean;
  /** 是否允许启用生物识别快速解锁（危险环境下不落硬件密钥）。 */
  allowBiometricFastUnlock: boolean;
  /** 首次进入是否必须确认风险全屏页。 */
  requireRiskAcknowledgement: boolean;
};

const SAFE_POLICY: SecurityPolicy = {
  allowKeyGeneration: true,
  requireBiometricPerTransaction: false,
  maxSendSats: null,
  allowSecretExport: true,
  allowBiometricFastUnlock: true,
  requireRiskAcknowledgement: false,
};

// danger 环境下的限额：约 0.01 BTC。目的是让用户可以继续用（比如有意 root 的
// 高级用户），但把单次损失上限压住。
const DANGER_MAX_SEND_SATS = 1_000_000;

export function getSecurityPolicy(state = getDeviceSecurityState()): SecurityPolicy {
  if (state.level === "ok") return SAFE_POLICY;
  if (state.level === "warn") {
    return { ...SAFE_POLICY, requireRiskAcknowledgement: true };
  }
  return {
    // 熵源降级时绝不允许生成新密钥；其余 danger 场景（越狱等）熵源本身没问题，
    // 生成仍然允许，只是收紧发送与导出。
    allowKeyGeneration: !state.entropyDegraded,
    requireBiometricPerTransaction: true,
    maxSendSats: DANGER_MAX_SEND_SATS,
    allowSecretExport: false,
    allowBiometricFastUnlock: false,
    requireRiskAcknowledgement: true,
  };
}

export class SecurityPolicyError extends Error {
  constructor(
    public readonly reason:
      | "amount-limit"
      | "export-blocked"
      | "biometric-required"
      | "key-generation-blocked",
  ) {
    super(`Blocked by device security policy: ${reason}`);
  }
}

/**
 * 发送前调用。danger 环境下超额直接拒绝。
 *
 * @param biometricConfirmed 本次发送是否已通过生物识别确认。
 *   policy.requireBiometricPerTransaction 之前是**声明了但全项目零引用**的死字段
 *   —— 文档写着"danger 环境每笔强制生物识别"，实际只有限额生效。现在真正接线。
 */
export function assertSendAllowed(amountSats: number, biometricConfirmed = false): void {
  const policy = getSecurityPolicy();
  if (policy.maxSendSats !== null && amountSats > policy.maxSendSats) {
    throw new SecurityPolicyError("amount-limit");
  }
  if (policy.requireBiometricPerTransaction && !biometricConfirmed) {
    throw new SecurityPolicyError("biometric-required");
  }
}

/** 调用方（UI）据此决定发送前是否要先弹一次生物识别。 */
export function needsBiometricForTransaction(): boolean {
  return getSecurityPolicy().requireBiometricPerTransaction;
}

/** 生成新钱包 / 冷钱包助记词前调用。 */
export function assertKeyGenerationAllowed(): void {
  if (!getSecurityPolicy().allowKeyGeneration) {
    throw new SecurityPolicyError("key-generation-blocked");
  }
}

/** 导出助记词 / 私钥前调用。 */
export function assertExportAllowed(): void {
  if (!getSecurityPolicy().allowSecretExport) {
    throw new SecurityPolicyError("export-blocked");
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 策略执行点登记表（根因 2：防止"定义了但没接线"复发）
//
// 【为什么需要】本次审计发现 SecurityPolicy 里有两个字段
// （requireBiometricPerTransaction / requireRiskAcknowledgement）**声明了但全项目
// 零引用** —— 文档写着"danger 环境每笔强制生物识别"，实际只有限额生效。
// 这类"防线看起来存在、实际不存在"的缺陷，靠 code review 很难发现：字段就在
// 类型里明晃晃写着，读代码的人会默认它被用了。
//
// 这张表把「每个策略字段必须有执行点」变成**编译期约束**：
// Record<keyof SecurityPolicy, ...> 要求穷尽，新增字段却不登记 → 编译失败。
// 配套的 securityPolicy.test.ts 再验证这些执行点在 danger 环境下真的会拦。
// ───────────────────────────────────────────────────────────────────────────

export type PolicyEnforcement = {
  /** 执行该策略的函数名，便于从字段反查代码。 */
  enforcedBy: string;
  /** 执行点所在模块。 */
  module: string;
};

export const POLICY_ENFORCEMENT: Record<keyof SecurityPolicy, PolicyEnforcement> = {
  allowKeyGeneration: {
    enforcedBy: "assertKeyGenerationAllowed",
    module: "services/security → wallet.generateMnemonic",
  },
  requireBiometricPerTransaction: {
    enforcedBy: "assertSendAllowed(amount, biometricConfirmed)",
    module: "services/security → transaction.buildUnsignedPsbt",
  },
  maxSendSats: {
    enforcedBy: "assertSendAllowed",
    module: "services/security → transaction.buildUnsignedPsbt",
  },
  allowSecretExport: {
    enforcedBy: "assertExportAllowed",
    module: "services/security → wallet.assertExportPermitted",
  },
  allowBiometricFastUnlock: {
    enforcedBy: "getSecurityPolicy().allowBiometricFastUnlock",
    module: "screens/SettingsScreen",
  },
  requireRiskAcknowledgement: {
    enforcedBy: "needsRiskAcknowledgement",
    module: "services/security → App risk gate",
  },
};

/**
 * 首次进入是否必须先确认风险全屏页。
 * 旧实现里这个策略字段没有任何读取者，UI 从来没弹过。
 */
export function needsRiskAcknowledgement(): boolean {
  return getSecurityPolicy().requireRiskAcknowledgement;
}

/** 仅供测试重置缓存。 */
export function __resetSecurityCache(): void {
  cached = null;
  probed = false;
  jailMonkey = null;
}

/** 仅供测试：注入一个伪造的设备安全状态。 */
export function __setSecurityStateForTests(state: DeviceSecurityState | null): void {
  cached = state;
}
