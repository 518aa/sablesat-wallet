import * as LocalAuthentication from "expo-local-authentication";
import { logger } from "./logger";

export type AuthMethod = "biometric" | "pin" | "none";

export async function hasBiometricHardware(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch (err) {
    logger.warn("Biometric availability probe failed", err);
    return false;
  }
}

export async function getAvailableAuthMethod(): Promise<AuthMethod> {
  return (await hasBiometricHardware()) ? "biometric" : "pin";
}

// 生物识别进行中标记：iOS 上 authenticateAsync 弹系统对话框会让 AppState 瞬态
// 进入 "inactive"，AppState 监听据此豁免锁定——否则签名流程在认证返回后调
// getRoot() 会因 cachedRoot 被清而抛 "Wallet locked"。finally 必复位。
let authInProgress = false;

export function isAuthInProgress(): boolean {
  return authInProgress;
}

export async function authenticate(
  reason: string,
  opts: { allowDevicePasscodeFallback?: boolean } = {},
): Promise<boolean> {
  if (!(await hasBiometricHardware())) return false;

  authInProgress = true;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: "取消",
      // 默认**不**允许设备密码回退：对钱包而言，设备密码通常比生物识别更容易
      // 被肩窥获取。需要回退的场景由调用方显式开启。
      disableDeviceFallback: opts.allowDevicePasscodeFallback !== true,
    });
    return result.success;
  } catch (err) {
    logger.warn("Biometric authentication threw", err);
    return false;
  } finally {
    authInProgress = false;
  }
}

/** 在 authInProgress 保护下执行一段会弹系统认证框的逻辑（如读取硬件密钥）。 */
export async function withAuthInProgress<T>(fn: () => Promise<T>): Promise<T> {
  authInProgress = true;
  try {
    return await fn();
  } finally {
    authInProgress = false;
  }
}

// 兼容再导出：PIN 校验现在由 wallet 层通过解密 vault 完成（见 wallet.verifyPin）。
export { verifyPin, isPinSet } from "./wallet";
