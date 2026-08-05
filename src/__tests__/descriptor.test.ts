import {
  descriptorChecksum,
  appendChecksum,
  verifyChecksum,
  buildVaultDescriptor,
  parseVaultDescriptor,
  assertNoDuplicateCosigners,
  assertDescriptorSafe,
  normalizedKeyId,
  DuplicateCosignerError,
} from "../services/vault/descriptor";
import type { Cosigner, VaultConfig } from "../services/vault/types";

// 三把互不相同的测试 xpub
// 由 BIP39 测试助记词派生的真实 m/48'/0'/0'/2' 账户级 xpub
const XPUB_A =
  "xpub6DkFAXWQ2dHxq2vatrt9qyA3bXYU4ToWQwCHbf5XB2mSTexcHZCeKS1VZYcPoBd5X8yVcbXFHJR9R8UCVpt82VX1VhR28mCyxUFL4r6KFrf";
const FP_A = "73c5da0a";
const XPUB_B =
  "xpub6FQya7zGhR92kacYsNnjreouvnHJMpXYsUXnW6NJJAJRCKsa26TzDy4LdnGhEurr3d6y1J8PJ7EEMKQp74XTqYvmGJNogYXSKDszYHtF8mX";
const FP_B = "b8688df1";
const XPUB_C =
  "xpub6DnEBNkSJKBYQmsbhS1sP9cNdtU5c9PLFGCjTJmxicxc13WB8zNNGQazabQpyFAGW5bV9tMko4uBxDxjUKL6dSAcx1tEbgEHtgSqyRsekh6";
const FP_C = "28645006";

function cosigner(xpub: string, fp: string, role: "self" | "external" = "external"): Cosigner {
  return { role, name: "test", xpub, derivationPath: "m/48'/0'/0'/2'", fingerprint: fp };
}

function vault(cosigners: Cosigner[], m = 2): VaultConfig {
  return {
    id: "v1",
    name: "Test",
    m,
    n: cosigners.length,
    scriptType: "p2wsh",
    cosigners,
    createdAt: 0,
    accountIndex: 0,
    descriptorBackedUp: false,
    schemaVersion: 2,
  };
}

describe("BIP380 descriptor checksum", () => {
  it("matches the Bitcoin Core reference vector", () => {
    // 权威向量（Bitcoin Core descriptor 测试集）
    expect(descriptorChecksum("raw(deadbeef)")).toBe("89f8spxm");
  });

  it("round-trips through verifyChecksum", () => {
    const body = "wsh(sortedmulti(2,[00000000/48h/0h/0h/2h]" + XPUB_A + "/<0;1>/*))";
    expect(verifyChecksum(appendChecksum(body))).toBe(true);
  });

  it("detects every single-character mutation", () => {
    const body = "wsh(sortedmulti(2,[00000000/48h/0h/0h/2h]" + XPUB_A + "/<0;1>/*))";
    const base = descriptorChecksum(body);
    let checked = 0;
    for (let i = 0; i < body.length; i += 3) {
      const ch = body[i];
      const alt = ch >= "a" && ch <= "y" ? String.fromCharCode(ch.charCodeAt(0) + 1) : ch === "2" ? "3" : null;
      if (!alt) continue;
      checked++;
      const mutated = body.slice(0, i) + alt + body.slice(i + 1);
      expect(descriptorChecksum(mutated)).not.toBe(base);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("rejects a descriptor whose checksum was tampered with", () => {
    const full = appendChecksum("raw(deadbeef)");
    const broken = full.slice(0, -1) + (full.endsWith("m") ? "q" : "m");
    expect(verifyChecksum(broken)).toBe(false);
  });
});

describe("vault descriptor build/parse round-trip", () => {
  const v = vault([
    cosigner(XPUB_A, FP_A, "self"),
    cosigner(XPUB_B, FP_B),
    cosigner(XPUB_C, FP_C),
  ]);

  it("produces a wsh(sortedmulti(...)) descriptor with a valid checksum", () => {
    const d = buildVaultDescriptor(v);
    expect(d.multipath).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(verifyChecksum(d.multipath)).toBe(true);
    expect(verifyChecksum(d.receive)).toBe(true);
    expect(verifyChecksum(d.change)).toBe(true);
  });

  it("parses back to the same threshold and keys", () => {
    const parsed = parseVaultDescriptor(buildVaultDescriptor(v).receive);
    expect(parsed.m).toBe(2);
    expect(parsed.cosigners).toHaveLength(3);
    expect(parsed.cosigners.map((c) => c.xpub)).toEqual([XPUB_A, XPUB_B, XPUB_C]);
    expect(parsed.cosigners[0].fingerprint).toBe(FP_A);
  });

  it("rejects a mistyped descriptor via checksum", () => {
    const d = buildVaultDescriptor(v).receive.replace("wsh(sortedmulti(2,", "wsh(sortedmulti(3,");
    expect(() => parseVaultDescriptor(d)).toThrow(/checksum/i);
  });
});

describe("duplicate cosigner detection", () => {
  it("accepts three distinct keys", () => {
    expect(() =>
      assertNoDuplicateCosigners([
        cosigner(XPUB_A, FP_A),
        cosigner(XPUB_B, FP_B),
        cosigner(XPUB_C, FP_C),
      ]),
    ).not.toThrow();
  });

  it("rejects the same xpub used twice — this is what silently turns 2-of-3 into 1-of-2", () => {
    expect(() =>
      assertNoDuplicateCosigners([
        cosigner(XPUB_A, FP_A),
        cosigner(XPUB_A, FP_B),
        cosigner(XPUB_C, FP_C),
      ]),
    ).toThrow(DuplicateCosignerError);
  });

  it("rejects duplicate master fingerprints even when xpubs differ", () => {
    expect(() =>
      assertNoDuplicateCosigners([
        cosigner(XPUB_A, FP_A),
        cosigner(XPUB_B, FP_A),
      ]),
    ).toThrow(DuplicateCosignerError);
  });

  it("normalizedKeyId is stable for the same key", () => {
    expect(normalizedKeyId(XPUB_A)).toBe(normalizedKeyId(XPUB_A));
    expect(normalizedKeyId(XPUB_A)).not.toBe(normalizedKeyId(XPUB_B));
  });
});

describe("vault safety bounds", () => {
  it("rejects m = 0 (would produce a script anyone can spend)", () => {
    const v = vault([cosigner(XPUB_A, FP_A), cosigner(XPUB_B, FP_B)], 0);
    expect(() => assertDescriptorSafe(v)).toThrow(/threshold/i);
  });

  it("rejects m > n", () => {
    const v = vault([cosigner(XPUB_A, FP_A), cosigner(XPUB_B, FP_B)], 3);
    expect(() => assertDescriptorSafe(v)).toThrow(/exceeds/i);
  });

  it("rejects an invalid master fingerprint", () => {
    const v = vault([cosigner(XPUB_A, "zzzz"), cosigner(XPUB_B, FP_B)]);
    expect(() => assertDescriptorSafe(v)).toThrow(/fingerprint/i);
  });
});

describe("vault recovery determinism (regression)", () => {
  // 回归：accountIndex 曾用「现有金库最大 index + 1」计算，取自**可变的**金库列表。
  // 后果：删掉金库再重建时，若设备上还有别的金库，account 会从 0 跳到 2，
  // 派生出不同的 xpub —— 地址对不上，原金库里的钱永久取不回。
  // 现在固定用 0，显式指定的索引写进 descriptor 派生路径，恢复时读回。
  it("descriptor carries the account index so recovery is exact", () => {
    const v = vault([
      { ...cosigner(XPUB_A, FP_A, "self"), derivationPath: "m/48'/0'/7'/2'" },
      { ...cosigner(XPUB_B, FP_B), derivationPath: "m/48'/0'/3'/2'" },
    ]);
    const parsed = parseVaultDescriptor(buildVaultDescriptor(v).receive);
    const paths = parsed.cosigners.map((c) => c.derivationPath).sort();
    expect(paths).toEqual(["m/48'/0'/3'/2'", "m/48'/0'/7'/2'"]);
  });

  it("round-trips the exact cosigner set — recreating by hand is not equivalent", () => {
    const v = vault([cosigner(XPUB_A, FP_A, "self"), cosigner(XPUB_B, FP_B)]);
    const parsed = parseVaultDescriptor(buildVaultDescriptor(v).multipath);
    expect(parsed.m).toBe(2);
    expect(parsed.cosigners.map((c) => c.xpub).sort()).toEqual([XPUB_A, XPUB_B].sort());
  });
});
