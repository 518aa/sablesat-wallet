// crypto.ts 加密原语回归测试（PIN / 助记词加密 / PSBT 校验的底层）。
// 锁死安全不变量：AES-GCM 往返与完整性、AAD 隔离（P0-2 基础）、
// nonce 不重用、KDF 确定性与 salt/pin 敏感性、constantTimeEqual。
// 这些不变量是 P0-2（计数并入 AAD）与 Step3+4 改动加密层时的回归网。
import { describe, it, expect } from "@jest/globals";
import { randomBytes } from "@noble/hashes/utils.js";
import {
  bytesToHex,
  hexToBytes,
  generateSalt,
  deriveKey,
  derivePinKey,
  encrypt,
  decrypt,
  constantTimeEqual,
  defaultScryptParams,
  encryptBytes,
  decryptBytes,
  integrityTag,
  verifyIntegrityTag,
} from "../services/crypto";

const enc = new TextEncoder();

describe("hex helpers", () => {
  it("round-trips bytes <-> hex", () => {
    const bytes = new Uint8Array([0, 15, 255, 128]);
    expect(bytesToHex(bytes)).toBe("000fff80");
    expect(hexToBytes("000fff80")).toEqual(bytes);
  });
  it("accepts 0x prefix", () => {
    expect(hexToBytes("0xff")).toEqual(new Uint8Array([255]));
  });
  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("abc")).toThrow(/Invalid hex length/);
  });
});

describe("generateSalt", () => {
  it("produces 16 random bytes, unique each call", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).toHaveLength(16);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe("deriveKey (scrypt)", () => {
  // 用小参数测确定性逻辑；真实强度由 defaultScryptParams() 常量保证。
  const fastParams = { N: 2, r: 8, p: 1 };

  it("is deterministic for same password+salt+params", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("password", salt, fastParams);
    const k2 = await deriveKey("password", salt, fastParams);
    expect(constantTimeEqual(k1, k2)).toBe(true);
    expect(k1).toHaveLength(32);
  });

  it("differs when salt differs (rainbow-table resistance)", async () => {
    const k1 = await deriveKey("pw", generateSalt(), fastParams);
    const k2 = await deriveKey("pw", generateSalt(), fastParams);
    expect(constantTimeEqual(k1, k2)).toBe(false);
  });

  it("defaultScryptParams() runs and yields 32 bytes", async () => {
    const k = await deriveKey("pw", generateSalt(), defaultScryptParams());
    expect(k).toHaveLength(32);
  });
});

describe("derivePinKey (pbkdf2)", () => {
  it("is deterministic and pin-sensitive", async () => {
    const salt = generateSalt();
    const k1 = await derivePinKey("123456", salt, 1000);
    const k2 = await derivePinKey("123456", salt, 1000);
    const k3 = await derivePinKey("654321", salt, 1000);
    expect(constantTimeEqual(k1, k2)).toBe(true);
    expect(constantTimeEqual(k1, k3)).toBe(false);
    expect(k1).toHaveLength(32);
  });

  it("differs when salt differs", async () => {
    const salt = generateSalt();
    const k1 = await derivePinKey("123456", salt, 1000);
    const k2 = await derivePinKey("123456", generateSalt(), 1000);
    expect(constantTimeEqual(k1, k2)).toBe(false);
  });
});

describe("AES-GCM encrypt/decrypt", () => {
  it("round-trips plaintext (incl. unicode)", () => {
    const key = randomBytes(32);
    const { nonce, ciphertext } = encrypt(key, "hello 助记词 secret ₿");
    expect(decrypt(key, nonce, ciphertext)).toBe("hello 助记词 secret ₿");
  });

  it("uses a fresh random nonce each call (no reuse)", () => {
    const key = randomBytes(32);
    const a = encrypt(key, "same");
    const b = encrypt(key, "same");
    expect(constantTimeEqual(a.nonce, b.nonce)).toBe(false);
    expect(constantTimeEqual(a.ciphertext, b.ciphertext)).toBe(false);
  });

  it("fails on tampered ciphertext (GCM integrity)", () => {
    const key = randomBytes(32);
    const { nonce, ciphertext } = encrypt(key, "secret");
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    expect(() => decrypt(key, nonce, tampered)).toThrow();
  });

  it("fails with wrong key", () => {
    const { nonce, ciphertext } = encrypt(randomBytes(32), "secret");
    expect(() => decrypt(randomBytes(32), nonce, ciphertext)).toThrow();
  });
});

// P0-2 关键不变量：AAD 是 GCM 的一部分。
// P0-2 将 PIN 失败计数并入 vault 密文 AAD 后，擦除计数 = 改 AAD = 无法解密。
// 这些测试锁死 AAD 隔离性，防止后续重构意外削弱。
describe("AAD isolation (P0-2 foundation)", () => {
  it("decrypt with wrong AAD fails, correct AAD succeeds", () => {
    const key = randomBytes(32);
    const aad1 = enc.encode("device-secret-1");
    const aad2 = enc.encode("device-secret-2");
    const { nonce, ciphertext } = encrypt(key, "vault-payload", aad1);
    expect(() => decrypt(key, nonce, ciphertext, aad2)).toThrow();
    expect(decrypt(key, nonce, ciphertext, aad1)).toBe("vault-payload");
  });

  it("omitting AAD when it was used fails (and vice versa)", () => {
    const key = randomBytes(32);
    const aad = enc.encode("aad");
    const sealed = encrypt(key, "x", aad);
    expect(() => decrypt(key, sealed.nonce, sealed.ciphertext)).toThrow();
    const sealedNoAad = encrypt(key, "x");
    expect(() => decrypt(key, sealedNoAad.nonce, sealedNoAad.ciphertext, aad)).toThrow();
  });
});

describe("constantTimeEqual", () => {
  it("returns true only for byte-identical inputs", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});


describe("DEK wrapping primitives (two-tier key architecture)", () => {
  it("encryptBytes/decryptBytes round-trips raw key material", () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    const { nonce, ciphertext } = encryptBytes(kek, dek);
    expect(decryptBytes(kek, nonce, ciphertext)).toEqual(dek);
  });

  it("wrong KEK fails GCM authentication — this IS the PIN check", () => {
    // 解锁路径不再单独跑 PBKDF2 比对哈希：GCM 认证标签失败即等价于 PIN 错误。
    const { nonce, ciphertext } = encryptBytes(randomBytes(32), randomBytes(32));
    expect(() => decryptBytes(randomBytes(32), nonce, ciphertext)).toThrow();
  });

  it("AAD mismatch fails authentication (device binding)", () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    const aad = randomBytes(32);
    const { nonce, ciphertext } = encryptBytes(kek, dek, aad);
    expect(() => decryptBytes(kek, nonce, ciphertext, randomBytes(32))).toThrow();
    expect(decryptBytes(kek, nonce, ciphertext, aad)).toEqual(dek);
  });
});

describe("keyed cache integrity (replaces unkeyed SHA256 + hardcoded salt)", () => {
  it("verifies a tag it produced", () => {
    const key = randomBytes(32);
    const data = JSON.stringify({ balanceSats: 12345 });
    expect(verifyIntegrityTag(key, data, integrityTag(key, data))).toBe(true);
  });

  it("rejects tampered data", () => {
    const key = randomBytes(32);
    const tag = integrityTag(key, JSON.stringify({ balanceSats: 12345 }));
    expect(verifyIntegrityTag(key, JSON.stringify({ balanceSats: 999999 }), tag)).toBe(false);
  });

  it("rejects a tag forged without the key — the old unkeyed hash could not do this", () => {
    const data = JSON.stringify({ balanceSats: 12345 });
    const attackerTag = integrityTag(randomBytes(32), data);
    expect(verifyIntegrityTag(randomBytes(32), data, attackerTag)).toBe(false);
  });
});
