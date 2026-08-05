// Vault 核心逻辑回归测试（资金安全关键路径）。
// 覆盖：BIP32 path 解析、多签地址派生（cosigner 排列无关性）、
// PSBT 构造→签名→合并→最终化往返、self 私钥与 xpub 派生一致性。
// 这些路径在签名链路改造（如 Step2 改吃 root）后必须保持数学等价。
import { describe, it, expect } from "@jest/globals";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseBip32Path } from "../services/wallet";
import {
  deriveSelfCosigner,
  deriveSelfPrivateKeyAt,
} from "../services/vault/cosigner";
import { sortedPubkeys, deriveVaultAddress } from "../services/vault/multisig";
import {
  buildVaultPsbt,
  signVaultPsbtSelf,
  combineVaultPsbt,
  finalizeAndExtract,
  summarizePsbt,
  inputsFromPsbt,
  planVaultChange,
  VaultDustChangeError,
} from "../services/vault/psbt";
import type { Cosigner, VaultConfig, VaultUtxo } from "../services/vault/types";

const MNEMONIC_A = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC_C = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

function rootFor(mnemonic: string): HDKey {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
}

function secpPub(priv: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(priv, true);
}

function makeCosigner(mnemonic: string, name: string): Cosigner {
  return { ...deriveSelfCosigner(rootFor(mnemonic)), name };
}

function buildTestVault(cosigners: Cosigner[]): VaultConfig {
  return {
    id: "test-vault",
    name: "Test Vault",
    m: 2,
    n: 3,
    scriptType: "p2wsh",
    cosigners,
    createdAt: 0,
    schemaVersion: 1,
  };
}

describe("BIP32 path parsing", () => {
  it("parses hardened + soft segments", () => {
    expect(parseBip32Path("m/48'/0'/0'/2'")).toEqual([0x80000030, 0x80000000, 0x80000000, 0x80000002]);
    expect(parseBip32Path("m/0/1/2")).toEqual([0, 1, 2]);
    expect(parseBip32Path("m/84'/0'/0'/0/0")).toEqual([0x80000054, 0x80000000, 0x80000000, 0, 0]);
  });
});

describe("BIP67 lexicographic sort", () => {
  it("sorts pubkeys lexicographically by hex", () => {
    const pubkeysHex = [
      "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd",
      "03b287eaf122eea69030d0d85dace891ff7c86c439b001d6c3a81bf7aa6ccb6d23",
      "024ce9c8d4c5c8c9d8a8b7c6a5b4c3d2e1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
    ];
    const expected = [...pubkeysHex].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = sortedPubkeys(pubkeysHex.map((h) => hex.decode(h))).map((p) => hex.encode(p));
    expect(sorted).toEqual(expected);
  });
});

describe("vault address derivation", () => {
  it("is invariant under cosigner permutation", () => {
    const a = makeCosigner(MNEMONIC_A, "A");
    const b = makeCosigner(MNEMONIC_B, "B");
    const c = makeCosigner(MNEMONIC_C, "C");
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    const addresses = new Set(orders.map((o) => deriveVaultAddress(buildTestVault(o).cosigners, false, 0, 2).address));
    expect(addresses.size).toBe(1);
  });

  it("produces a mainnet bech32 P2WSH address", () => {
    const vault = buildTestVault([makeCosigner(MNEMONIC_A, "A"), makeCosigner(MNEMONIC_B, "B"), makeCosigner(MNEMONIC_C, "C")]);
    const { address } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    expect(address.startsWith("bc1")).toBe(true);
  });
});

describe("self private key consistency (Step2 regression: root vs xpub)", () => {
  it("derives the same pubkey from root-private path and xpub path", () => {
    const root = rootFor(MNEMONIC_A);
    const derived = deriveSelfCosigner(root);
    const privChild = root.derive("m/48'/0'/0'/2'/0/0");
    if (!privChild.privateKey || !privChild.publicKey) throw new Error("missing key material");

    const xpubAccount = HDKey.fromExtendedKey(derived.xpub);
    const xpubChild = xpubAccount.derive("m/0/0");
    if (!xpubChild.publicKey) throw new Error("missing xpub child pubkey");

    // deriveSelfPrivateKeyAt 现在吃 root（Step2 改造），派生结果必须与 xpub 一致
    const privFromFn = deriveSelfPrivateKeyAt(root, false, 0);
    const xpubChildPubHex = hex.encode(xpubChild.publicKey);
    expect(hex.encode(privChild.publicKey)).toBe(xpubChildPubHex);
    expect(hex.encode(secpPub(privFromFn))).toBe(xpubChildPubHex);
  });
});

describe("PSBT round-trip (build → sign A → sign B → combine → finalize)", () => {
  it("produces a finalizable 2-of-2 signed tx, order-independent", () => {
    const vault = buildTestVault([makeCosigner(MNEMONIC_A, "A"), makeCosigner(MNEMONIC_B, "B"), makeCosigner(MNEMONIC_C, "C")]);
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);

    const fakeUtxo: VaultUtxo = {
      txid: "0000000000000000000000000000000000000000000000000000000000000001",
      vout: 0,
      value: 100000,
      address: spendAddress,
      derivationIndex: 0,
      isChange: false,
    };

    const unsigned = buildVaultPsbt({
      vault,
      inputs: [fakeUtxo],
      recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
      changeIsChange: true,
      changeIndex: 0,
      feeRate: 10,
    });

    expect(unsigned.length).toBeGreaterThan(0);
    expect(summarizePsbt(unsigned, vault, [fakeUtxo]).signaturesPerInput[0]).toBe(0);

    // Step2: signVaultPsbtSelf 吃 root
    const signedByA = signVaultPsbtSelf(unsigned, vault, [fakeUtxo], rootFor(MNEMONIC_A));
    expect(summarizePsbt(signedByA, vault, [fakeUtxo]).signaturesPerInput[0]).toBe(1);
    expect(summarizePsbt(signedByA, vault, [fakeUtxo]).readyToFinalize).toBe(false);

    const signedByB = signVaultPsbtSelf(unsigned, vault, [fakeUtxo], rootFor(MNEMONIC_B));
    const combined = combineVaultPsbt(signedByA, signedByB);
    expect(summarizePsbt(combined, vault, [fakeUtxo]).signaturesPerInput[0]).toBe(2);
    expect(summarizePsbt(combined, vault, [fakeUtxo]).readyToFinalize).toBe(true);

    const rawHex = finalizeAndExtract(combined);
    expect(/^[0-9a-f]+$/.test(rawHex)).toBe(true);

    // combine/finalize 与签名顺序无关
    const rawHex2 = finalizeAndExtract(combineVaultPsbt(signedByB, signedByA));
    expect(rawHex2).toBe(rawHex);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 「Change below dust threshold: 92 sats」—— 旧实现因为一个几毛钱的零头
  // 把整笔金库转账彻底堵死，且用户无论怎么调金额都可能再撞上。
  // 92 sats 根本不可能变成输出（低于 546 的输出是 dust，中继节点拒收），
  // 计入矿工费是比特币规则下**唯一**的合法处理方式。
  describe("找零 dust 决策（金库发币被零头卡死的回归）", () => {
    const feeNoChange = 700;
    const feeWithChange = 870; // 多一个 34 vB 输出 @5 sat/vB
    const base = { outputSum: 100_000, feeWithChange, feeNoChange };

    it("92 sats 零头不再阻断交易，计入矿工费", () => {
      const plan = planVaultChange({
        ...base,
        inputSum: 100_000 + feeNoChange + 92,
        acceptDustToFee: false,
      });
      expect(plan.kind).toBe("no-change");
      expect(plan.dustToFeeSats).toBe(92);
      expect(plan.feeSats).toBe(feeNoChange + 92);
    });

    it("零头等于 dust 门槛 546 仍放行——546 同样建不出合规输出", () => {
      const plan = planVaultChange({
        ...base,
        inputSum: 100_000 + feeNoChange + 546,
        acceptDustToFee: false,
      });
      expect(plan.dustToFeeSats).toBe(546);
    });

    it("零头超过 dust 时金额可感知，必须由用户确认而不是静默烧掉", () => {
      expect(() =>
        planVaultChange({ ...base, inputSum: 100_000 + feeNoChange + 547, acceptDustToFee: false }),
      ).toThrow(VaultDustChangeError);
      const plan = planVaultChange({
        ...base,
        inputSum: 100_000 + feeNoChange + 547,
        acceptDustToFee: true,
      });
      expect(plan.dustToFeeSats).toBe(547);
    });

    it("余额充足时正常建找零，不走 dust 分支", () => {
      const plan = planVaultChange({
        ...base,
        inputSum: 100_000 + feeWithChange + 50_000,
        acceptDustToFee: false,
      });
      expect(plan.kind).toBe("change");
      expect(plan.changeSats).toBe(50_000);
      expect(plan.dustToFeeSats).toBe(0);
    });

    it("余额不足仍报余额不足，不能被 dust 逻辑吃掉", () => {
      expect(() =>
        planVaultChange({ ...base, inputSum: 100_000, acceptDustToFee: true }),
      ).toThrow(/Insufficient funds/);
    });
  });

  it("rejects insufficient funds", () => {
    const vault = buildTestVault([makeCosigner(MNEMONIC_A, "A"), makeCosigner(MNEMONIC_B, "B"), makeCosigner(MNEMONIC_C, "C")]);
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const fakeUtxo: VaultUtxo = {
      txid: "0000000000000000000000000000000000000000000000000000000000000001",
      vout: 0, value: 1000, address: spendAddress, derivationIndex: 0, isChange: false,
    };
    expect(() =>
      buildVaultPsbt({
        vault, inputs: [fakeUtxo],
        recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
        changeIsChange: true, changeIndex: 0, feeRate: 10,
      }),
    ).toThrow(/Insufficient funds/);
  });
});

describe("inputsFromPsbt recovers change + nonzero receive (cosign bug regression)", () => {
  it("recovers both inputs with correct change/index", () => {
    const vault = buildTestVault([makeCosigner(MNEMONIC_A, "A"), makeCosigner(MNEMONIC_B, "B"), makeCosigner(MNEMONIC_C, "C")]);
    const { address: r0 } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const { address: c3 } = deriveVaultAddress(vault.cosigners, true, 3, 2);

    const in1: VaultUtxo = { txid: "00".repeat(31) + "a1", vout: 0, value: 100000, address: r0, derivationIndex: 0, isChange: false };
    const in2: VaultUtxo = { txid: "00".repeat(31) + "a2", vout: 1, value: 50000, address: c3, derivationIndex: 3, isChange: true };

    const unsigned = buildVaultPsbt({
      vault, inputs: [in1, in2],
      recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
      changeIsChange: true, changeIndex: 0, feeRate: 10,
    });

    const self = vault.cosigners.find((c) => c.role === "self")!;
    const recovered = inputsFromPsbt(unsigned, self.xpub);
    expect(recovered).toHaveLength(2);
    const byKey = new Map(recovered.map((u) => [`${u.isChange}:${u.derivationIndex}`, u]));
    expect(byKey.get("false:0")).toBeTruthy();
    expect(byKey.get("true:3")).toBeTruthy();
    expect(byKey.get("true:3")!.value).toBe(50000);
  });
});
