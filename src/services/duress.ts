import * as SecureStore from "expo-secure-store";
import { sealWithPin, openSealedWithPin, dummyKdf, WrongPinError, type SealedRecord } from "./vaultKey";
import { assertValidNewPin, getLockState, beginAttempt, resetFailures } from "./pin";
import { logger } from "./logger";

// ───────────────────────────────────────────────────────────────────────────
// 胁迫钱包（duress wallet）
//
// 【与旧实现的关键差异】
// 旧方案把 { mnemonic: <主助记词>, passphrase: <胁迫口令词> } 用胁迫 PIN 加密
// 存盘。这意味着胁迫 payload 里装的**就是主钱包助记词本体**——胁迫者拿到设备
// 和胁迫 PIN 后，直接 dump Keychain 里的 blob 离线解密即可拿到主助记词，
// assertNotDuress() 那层 App 内封锁形同虚设。
//
// 现在：诱饵钱包使用**独立生成的助记词**，与主 vault 在密码学上完全无关联。
// 即使胁迫 payload 被完整导出并解密，泄露的也只是诱饵钱包（用户只往里放少量
// 资金），主种子不受影响。
// ───────────────────────────────────────────────────────────────────────────

const DURESS_PAYLOAD_KEY = "sablesat.duress.payload.v2";
const DURESS_COUNTER_KEY = "sablesat.duress.counter.v2";

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type DuressPayload = {
  v: 2;
  /** 独立生成的诱饵助记词。与主 vault 无任何派生关系。 */
  mnemonic: string;
  passphrase: string;
  createdAt: number;
};

type Counter = { failures: number; lastFailureAt: number };

const BACKOFF_MS = [0, 0, 0, 0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

async function readCounter(): Promise<Counter> {
  const raw = await SecureStore.getItemAsync(DURESS_COUNTER_KEY, SECURE_OPTS).catch(() => null);
  if (!raw) return { failures: 0, lastFailureAt: 0 };
  try {
    return JSON.parse(raw) as Counter;
  } catch {
    return { failures: 0, lastFailureAt: 0 };
  }
}

async function writeCounter(c: Counter): Promise<void> {
  await SecureStore.setItemAsync(DURESS_COUNTER_KEY, JSON.stringify(c), SECURE_OPTS).catch(() => {});
}

export async function hasDuressWallet(): Promise<boolean> {
  return (await SecureStore.getItemAsync(DURESS_PAYLOAD_KEY, SECURE_OPTS).catch(() => null)) !== null;
}

/**
 * 设置胁迫钱包。
 * @param duressMnemonic 调用方生成的**独立**助记词（见 wallet.setupDuressEntry）
 */
export async function setupDuress(
  duressPin: string,
  duressMnemonic: string,
  duressPassphrase: string,
  mainPinEquals: (pin: string) => boolean,
): Promise<void> {
  assertValidNewPin(duressPin);
  if (mainPinEquals(duressPin)) {
    throw new Error("Duress PIN must differ from main PIN");
  }
  const payload: DuressPayload = {
    v: 2,
    mnemonic: duressMnemonic,
    passphrase: duressPassphrase,
    createdAt: Date.now(),
  };
  const sealed = await sealWithPin(duressPin, JSON.stringify(payload));
  await SecureStore.setItemAsync(DURESS_PAYLOAD_KEY, JSON.stringify(sealed), SECURE_OPTS);
  await writeCounter({ failures: 0, lastFailureAt: 0 });
}

/**
 * 尝试用给定 PIN 解开胁迫 payload。
 *
 * 恒定时序：payload 不存在时跑一次同参数 scrypt 占位，不泄露胁迫钱包存在性。
 * 旧实现在这里跑的是 600k PBKDF2（约 1.5s），错误 PIN 要等 2.9s；
 * 现在同样的时序保证只需约 90ms。
 */
export async function tryOpenDuress(pin: string): Promise<DuressPayload | null> {
  const raw = await SecureStore.getItemAsync(DURESS_PAYLOAD_KEY, SECURE_OPTS).catch(() => null);
  if (!raw) {
    await dummyKdf(pin);
    return null;
  }

  const c = await readCounter();
  const backoff = BACKOFF_MS[Math.min(c.failures, BACKOFF_MS.length - 1)];
  if (backoff > 0 && Date.now() < c.lastFailureAt + backoff) {
    // 锁定态也跑一次 KDF，避免"立即返回"泄露胁迫钱包存在性。
    await dummyKdf(pin);
    return null;
  }

  let sealed: SealedRecord;
  try {
    sealed = JSON.parse(raw) as SealedRecord;
  } catch {
    logger.warn("Duress payload corrupt");
    await dummyKdf(pin);
    return null;
  }

  await writeCounter({ failures: c.failures + 1, lastFailureAt: Date.now() });

  let plaintext: string;
  try {
    plaintext = await openSealedWithPin(pin, sealed);
  } catch (err) {
    if (!(err instanceof WrongPinError)) logger.warn("Duress open failed", err);
    return null;
  }

  let payload: DuressPayload;
  try {
    payload = JSON.parse(plaintext) as DuressPayload;
  } catch {
    logger.warn("Duress payload malformed");
    return null;
  }
  if (payload.v !== 2 || typeof payload.mnemonic !== "string" || typeof payload.passphrase !== "string") {
    logger.warn("Duress payload invalid shape");
    return null;
  }

  await writeCounter({ failures: 0, lastFailureAt: 0 });
  return payload;
}

/** 只清胁迫数据，绝不触碰主 vault。 */
export async function clearDuress(): Promise<void> {
  await SecureStore.deleteItemAsync(DURESS_PAYLOAD_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(DURESS_COUNTER_KEY).catch(() => {});
}

export { getLockState as getDuressLockState, beginAttempt as beginDuressAttempt, resetFailures as resetDuressFailures };
