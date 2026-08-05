import * as SecureStore from "expo-secure-store";
import {
  bytesToHex,
  hexToBytes,
  deriveKey,
  generateKey,
  generateSalt,
  encrypt,
  decrypt,
  encryptBytes,
  decryptBytes,
  defaultScryptParams,
  type ScryptParams,
} from "./crypto";
import { secureRandomBytes } from "./randomness";
import { logger } from "./logger";

// ───────────────────────────────────────────────────────────────────────────
// 两级密钥架构（KEK / DEK）
//
//   随机 DEK(32B) ──AES-256-GCM──> vault(助记词)
//
//   DEK 被两条路径分别包裹：
//     ① 生物识别路径  DEK 明文存 SecureStore，requireAuthentication:true
//                    → 由 Secure Enclave / Keystore 硬件门禁放行
//                    → 解锁 0 次 KDF，仅一次 GCM 解密（<100ms）
//     ② PIN 路径      wrap(DEK, scrypt(PIN)) → 生物识别不可用/失效时的回退
//
// 收益：
//   - 日常解锁不跑 KDF
//   - 改 PIN 只需重新包裹 32 字节 DEK，不必重新加密整个 vault
//   - DEK 在 SE 内不可导出，离线爆破 PIN 这个攻击面被消除
//
// 代价（调用方必须处理）：
//   - 生物识别重录 / 移除设备密码会使 ① 失效 → 必须保留 ② 并能重建 ①
//   - 因此启用前必须完成助记词备份确认
// ───────────────────────────────────────────────────────────────────────────

const VAULT_KEY = "sablesat.vault.v3";
const DEK_PIN_KEY = "sablesat.dek.pin.v1";
const DEK_BIO_KEY = "sablesat.dek.bio.v1";
const DEVICE_SECRET_KEY = "sablesat.device.v1";

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type WrappedDek = {
  v: 1;
  saltHex: string;
  kdf: ScryptParams;
  nonceHex: string;
  ciphertextHex: string;
};

type SealedBlob = {
  v: 3;
  nonceHex: string;
  ciphertextHex: string;
};

export class BiometricKeyUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Biometric-protected key unavailable (re-enrolled or passcode removed)");
    this.cause = cause;
  }
}

export class WrongPinError extends Error {
  constructor() {
    super("Incorrect PIN");
  }
}

// ── device secret：作为 GCM 的 AAD，把密文绑定到本设备 ──

let cachedDeviceSecret: Uint8Array | null = null;

async function getDeviceSecret(): Promise<Uint8Array> {
  if (cachedDeviceSecret) return cachedDeviceSecret;
  let stored = await SecureStore.getItemAsync(DEVICE_SECRET_KEY, SECURE_OPTS).catch(() => null);
  if (!stored) {
    stored = bytesToHex(secureRandomBytes(32));
    await SecureStore.setItemAsync(DEVICE_SECRET_KEY, stored, SECURE_OPTS);
  }
  cachedDeviceSecret = hexToBytes(stored);
  return cachedDeviceSecret;
}

// ── DEK 包裹 / 解包 ──

async function wrapDekWithPin(dek: Uint8Array, pin: string): Promise<WrappedDek> {
  const salt = generateSalt();
  const kdf = defaultScryptParams();
  const kek = await deriveKey(pin, salt, kdf);
  try {
    const aad = await getDeviceSecret();
    const { nonce, ciphertext } = encryptBytes(kek, dek, aad);
    return {
      v: 1,
      saltHex: bytesToHex(salt),
      kdf,
      nonceHex: bytesToHex(nonce),
      ciphertextHex: bytesToHex(ciphertext),
    };
  } finally {
    kek.fill(0);
  }
}

async function unwrapDekWithPin(record: WrappedDek, pin: string): Promise<Uint8Array> {
  const kek = await deriveKey(pin, hexToBytes(record.saltHex), record.kdf);
  try {
    const aad = await getDeviceSecret();
    // GCM 认证标签校验失败 = PIN 错。解密本身就是认证，无需额外哈希比对。
    return decryptBytes(kek, hexToBytes(record.nonceHex), hexToBytes(record.ciphertextHex), aad);
  } catch {
    throw new WrongPinError();
  } finally {
    kek.fill(0);
  }
}

// ── 公开 API ──

export async function hasVault(): Promise<boolean> {
  const [vault, dek] = await Promise.all([
    SecureStore.getItemAsync(VAULT_KEY, SECURE_OPTS).catch(() => null),
    SecureStore.getItemAsync(DEK_PIN_KEY, SECURE_OPTS).catch(() => null),
  ]);
  return vault !== null && dek !== null;
}

/** 首次创建：生成 DEK，加密 plaintext，用 PIN 包裹 DEK。返回 DEK 供调用方启用生物识别。 */
export async function createVault(pin: string, plaintext: string): Promise<Uint8Array> {
  const dek = generateKey();
  const aad = await getDeviceSecret();
  const { nonce, ciphertext } = encrypt(dek, plaintext, aad);
  const sealed: SealedBlob = {
    v: 3,
    nonceHex: bytesToHex(nonce),
    ciphertextHex: bytesToHex(ciphertext),
  };
  const wrapped = await wrapDekWithPin(dek, pin);
  // 两次写入不是原子的。hasVault() 要求 VAULT_KEY 与 DEK_PIN_KEY 同时存在，
  // 所以**先写 DEK 再写 vault**：中途崩溃时残留的是一个孤立的 DEK 记录，
  // hasVault() 仍返回 false（用户看到"未创建钱包"，符合事实）。
  // 反过来先写 vault 的话，残留的是一份永远解不开的密文，且下次创建时被覆盖。
  await SecureStore.setItemAsync(DEK_PIN_KEY, JSON.stringify(wrapped), SECURE_OPTS);
  try {
    await SecureStore.setItemAsync(VAULT_KEY, JSON.stringify(sealed), SECURE_OPTS);
  } catch (err) {
    // 回滚孤立的 DEK，避免下次 createVault 读到半成品状态。
    await SecureStore.deleteItemAsync(DEK_PIN_KEY).catch(() => {});
    throw err;
  }
  return dek;
}

async function readSealed(): Promise<SealedBlob> {
  const raw = await SecureStore.getItemAsync(VAULT_KEY, SECURE_OPTS);
  if (!raw) throw new Error("Vault not found");
  const sealed = JSON.parse(raw) as SealedBlob;
  if (sealed.v !== 3 || !sealed.nonceHex || !sealed.ciphertextHex) {
    throw new Error("Vault corrupt");
  }
  return sealed;
}

async function openWithDek(dek: Uint8Array): Promise<string> {
  const sealed = await readSealed();
  const aad = await getDeviceSecret();
  return decrypt(dek, hexToBytes(sealed.nonceHex), hexToBytes(sealed.ciphertextHex), aad);
}

/** PIN 路径解锁：1 次 scrypt 解开 DEK，再 GCM 解 vault。 */
export async function openVaultWithPin(pin: string): Promise<{ plaintext: string; dek: Uint8Array }> {
  const raw = await SecureStore.getItemAsync(DEK_PIN_KEY, SECURE_OPTS);
  if (!raw) throw new Error("Vault not found");
  const record = JSON.parse(raw) as WrappedDek;
  const dek = await unwrapDekWithPin(record, pin);
  return { plaintext: await openWithDek(dek), dek };
}

/** 生物识别路径解锁：0 次 KDF。DEK 由 Secure Enclave / Keystore 门禁保护。 */
export async function openVaultWithBiometrics(
  prompt: string,
): Promise<{ plaintext: string; dek: Uint8Array }> {
  let hex: string | null;
  try {
    hex = await SecureStore.getItemAsync(DEK_BIO_KEY, {
      keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
      requireAuthentication: true,
      authenticationPrompt: prompt,
    });
  } catch (err) {
    // 生物识别重新录入 / 移除设备密码 → Keychain item 失效。
    // 不是错误状态，回退到 PIN 路径即可。
    logger.info("Biometric key read failed, falling back to PIN", err);
    throw new BiometricKeyUnavailableError(err);
  }
  if (!hex) throw new BiometricKeyUnavailableError();
  const dek = hexToBytes(hex);
  return { plaintext: await openWithDek(dek), dek };
}

export async function isBiometricUnlockEnabled(): Promise<boolean> {
  // 只探测存在性，不触发生物识别弹窗：用一个不带 requireAuthentication 的读取
  // 会失败（ACL 不匹配），因此改用独立的标记键。
  const flag = await SecureStore.getItemAsync(`${DEK_BIO_KEY}.enabled`, SECURE_OPTS).catch(
    () => null,
  );
  return flag === "1";
}

/** 启用生物识别快速解锁。必须在助记词备份确认之后调用。 */
export async function enableBiometricUnlock(dek: Uint8Array): Promise<void> {
  await SecureStore.setItemAsync(DEK_BIO_KEY, bytesToHex(dek), {
    keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
    requireAuthentication: true,
  });
  await SecureStore.setItemAsync(`${DEK_BIO_KEY}.enabled`, "1", SECURE_OPTS);
}

export async function disableBiometricUnlock(): Promise<void> {
  await SecureStore.deleteItemAsync(DEK_BIO_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(`${DEK_BIO_KEY}.enabled`).catch(() => {});
}

/**
 * 改 PIN：只重新包裹 DEK，不碰 vault 密文。
 * 旧实现要跑 4 次 KDF + 重新加密整个 vault（实测 3.1s）；这里只 1 次 scrypt。
 */
export async function rewrapDekWithNewPin(dek: Uint8Array, newPin: string): Promise<void> {
  const wrapped = await wrapDekWithPin(dek, newPin);
  await SecureStore.setItemAsync(DEK_PIN_KEY, JSON.stringify(wrapped), SECURE_OPTS);
}

export async function clearVault(): Promise<void> {
  cachedDeviceSecret = null;
  await Promise.all(
    [VAULT_KEY, DEK_PIN_KEY, DEK_BIO_KEY, `${DEK_BIO_KEY}.enabled`, DEVICE_SECRET_KEY].map((k) =>
      SecureStore.deleteItemAsync(k).catch(() => {}),
    ),
  );
}

// ── 通用密封 blob（胁迫 payload 等复用同一套封装）──

export type SealedRecord = { v: 1; saltHex: string; kdf: ScryptParams; nonceHex: string; ciphertextHex: string };

export async function sealWithPin(pin: string, plaintext: string): Promise<SealedRecord> {
  const salt = generateSalt();
  const kdf = defaultScryptParams();
  const key = await deriveKey(pin, salt, kdf);
  try {
    const aad = await getDeviceSecret();
    const { nonce, ciphertext } = encrypt(key, plaintext, aad);
    return {
      v: 1,
      saltHex: bytesToHex(salt),
      kdf,
      nonceHex: bytesToHex(nonce),
      ciphertextHex: bytesToHex(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

export async function openSealedWithPin(pin: string, record: SealedRecord): Promise<string> {
  const key = await deriveKey(pin, hexToBytes(record.saltHex), record.kdf);
  try {
    const aad = await getDeviceSecret();
    return decrypt(key, hexToBytes(record.nonceHex), hexToBytes(record.ciphertextHex), aad);
  } catch {
    throw new WrongPinError();
  } finally {
    key.fill(0);
  }
}

/**
 * 恒定时序占位：胁迫 payload 不存在时跑一次**同参数** scrypt，不泄露存在性。
 *
 * 【为什么不能用 defaultScryptParams()】它的返回值依赖 isNativeKdfActive()：
 * 原生 KDF 可用时 N=32768，纯 JS 回退时 N=16384。而真实解密用的是**记录里
 * 存的**参数。一个在 Expo Go（N=16384）里建的胁迫钱包，到正式包（N=32768）
 * 里解锁时，占位 KDF 会比真实 KDF 慢一倍——攻击者掐表就能判断"这台设备上
 * 有没有胁迫钱包"，恒定时序保证直接失效。
 *
 * 现在从主 vault 的 DEK 记录里读回实际参数（两者由同一次 defaultScryptParams()
 * 产生），读不到时才退回默认值。
 */
export async function dummyKdf(pin: string): Promise<void> {
  let params = defaultScryptParams();
  try {
    const raw = await SecureStore.getItemAsync(DEK_PIN_KEY, SECURE_OPTS);
    if (raw) {
      const record = JSON.parse(raw) as WrappedDek;
      if (record?.kdf && Number.isInteger(record.kdf.N)) params = record.kdf;
    }
  } catch {
    /* 读不到就用默认参数 */
  }
  const key = await deriveKey(pin, new Uint8Array(16), params);
  key.fill(0);
}
