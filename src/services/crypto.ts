import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { secureRandomBytes } from "./randomness";
import { pbkdf2Sha256, scryptKdf, hmacSha256, isNativeKdfActive, type ScryptParams } from "./kdf";

export type { ScryptParams };

const KEY_LEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;

// scrypt 参数。原生 KDF 可用时用更高的 N（内存硬度翻倍，代价约 50ms）；
// 纯 JS 回退路径保守取 16384，避免低端 Android 上 32MB 的 Uint32Array 造成内存压力。
// 实际使用的参数会写进每条加密记录，解密时按记录里的参数还原。
const SCRYPT_N_NATIVE = 32768;
const SCRYPT_N_JS = 16384;

export function defaultScryptParams(): ScryptParams {
  return { N: isNativeKdfActive() ? SCRYPT_N_NATIVE : SCRYPT_N_JS, r: 8, p: 1 };
}

// PIN 校验 KDF。注意：解锁主路径**不再**跑这个 —— vault 用 AES-GCM 加密，
// PIN 错会导致认证标签校验失败，解密本身就是强认证，再哈希比对一次是纯冗余
// 开销（实测占解锁总耗时 92%）。此函数只保留给「已解锁状态下二次确认 PIN」等
// 无 vault 可解的场景。
export const PIN_PBKDF2_ITERATIONS = 600_000;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (trimmed.length % 2 !== 0) throw new Error("Invalid hex length");
  if (!/^[0-9a-fA-F]*$/.test(trimmed)) throw new Error("Invalid hex characters");
  const out = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < trimmed.length; i += 2) {
    out[i / 2] = parseInt(trimmed.slice(i, i + 2), 16);
  }
  return out;
}

export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// 全部经由 randomness.secureRandomBytes —— 它会在熵源可能降级时 hard-fail，
// 而不是像 expo-crypto 的同步 getRandomBytes 那样静默退化到 Math.random()。
export function generateSalt(): Uint8Array {
  return secureRandomBytes(SALT_LEN);
}

export function generateKey(): Uint8Array {
  return secureRandomBytes(KEY_LEN);
}

function generateNonce(): Uint8Array {
  return secureRandomBytes(NONCE_LEN);
}

export async function deriveKey(
  password: string,
  salt: Uint8Array,
  params: ScryptParams = defaultScryptParams(),
): Promise<Uint8Array> {
  return scryptKdf(utf8ToBytes(password), salt, params, KEY_LEN);
}

export async function derivePinKey(
  pin: string,
  salt: Uint8Array,
  iterations: number = PIN_PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  return pbkdf2Sha256(utf8ToBytes(pin), salt, iterations, KEY_LEN);
}

export function encrypt(
  key: Uint8Array,
  plaintext: string,
  aad: Uint8Array = new Uint8Array(),
): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = generateNonce();
  const cipher = gcm(key, nonce, aad);
  return { nonce, ciphertext: cipher.encrypt(utf8ToBytes(plaintext)) };
}

export function decrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): string {
  const cipher = gcm(key, nonce, aad);
  return bytesToUtf8(cipher.decrypt(ciphertext));
}

/** 加解密裸字节（用于包裹 DEK，不走 utf8 编解码）。 */
export function encryptBytes(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = generateNonce();
  return { nonce, ciphertext: gcm(key, nonce, aad).encrypt(plaintext) };
}

export function decryptBytes(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): Uint8Array {
  return gcm(key, nonce, aad).decrypt(ciphertext);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * 带密钥的完整性标签。用于本地缓存防篡改 —— 之前用的是
 * SHA256(硬编码盐 + 数据)，盐在 App bundle 里，能改缓存的攻击者同样能算出
 * 新哈希，只防损坏不防篡改。HMAC 的密钥来自钱包 root 派生，攻击者拿不到。
 */
export function integrityTag(key: Uint8Array, data: string): string {
  return bytesToHex(hmacSha256(key, utf8ToBytes(data)));
}

export function verifyIntegrityTag(key: Uint8Array, data: string, tagHex: string): boolean {
  try {
    return constantTimeEqual(hexToBytes(integrityTag(key, data)), hexToBytes(tagHex));
  } catch {
    return false;
  }
}

/** SHA256(SHA256(x))，BIP32 序列化校验和用。 */
export function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}
