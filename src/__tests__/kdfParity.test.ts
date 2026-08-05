import { pbkdf2Sha256, scryptKdf, isNativeKdfActive } from "../services/kdf";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * 原生（react-native-quick-crypto）与纯 JS（@noble）两条实现必须产出**逐字节
 * 一致**的结果。若不一致，用户在 Expo Go 里创建的钱包会在正式包里解不开。
 *
 * ⚠️ **本文件验证不了原生分支。** jest 跑在 Node 里，react-native-quick-crypto
 * 加载不了，isNativeKdfActive() 恒为 false —— 下面比的是「@noble 对 @noble」。
 * 这个测试全绿**不代表**原生与 JS 一致。
 *
 * 真正的一致性校验只能在真机上做：见 kdf.checkKdfParity()，已接入设置页诊断，
 * 并在 createWallet / importWallet 前强制执行（assertKdfParityOk）。
 */
const enc = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

describe("KDF abstraction", () => {
  const salt = new Uint8Array(16).fill(7);

  it("confirms this suite is exercising the JS path only", () => {
    // 若此断言在某天失败，说明测试环境能加载原生模块了，
    // 那时本文件才真正具备比对两条实现的能力。
    expect(isNativeKdfActive()).toBe(false);
  });

  it("PBKDF2-SHA256 matches the @noble reference", async () => {
    const got = await pbkdf2Sha256(enc("123456"), salt, 1000, 32);
    const want = await pbkdf2Async(sha256, enc("123456"), salt, { c: 1000, dkLen: 32 });
    expect(hex(got)).toBe(hex(want));
  });

  it("scrypt matches the @noble reference", async () => {
    const params = { N: 1024, r: 8, p: 1 };
    const got = await scryptKdf(enc("123456"), salt, params, 32);
    const want = await scryptAsync(enc("123456"), salt, { ...params, dkLen: 32, maxmem: 1 << 27 });
    expect(hex(got)).toBe(hex(want));
  });

  it("produces different keys for different PINs", async () => {
    const params = { N: 1024, r: 8, p: 1 };
    const a = await scryptKdf(enc("111111"), salt, params, 32);
    const b = await scryptKdf(enc("222222"), salt, params, 32);
    expect(hex(a)).not.toBe(hex(b));
  });
});
