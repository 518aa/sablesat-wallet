// 多签签名端的输出数深度防御 (P0-1)。
// 攻击场景：协同方构造含 2 个外部收款输出的 PSBT（攻击者地址 + 合法收款方），
// 单签路径 transaction.signPsbtOffline 已防，多签此处补齐：签名端 hard-fail
// 不依赖 UI 摘要作最后防线。
import { describe, it, expect } from "@jest/globals";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { base64 } from "@scure/base";
import {
  deriveSelfCosigner,
} from "../services/vault/cosigner";
import { deriveVaultAddress } from "../services/vault/multisig";
import { buildVaultPsbt, signVaultPsbtSelf } from "../services/vault/psbt";
import { getBtcNetwork } from "../services/network-mode";
import type { Cosigner, VaultConfig, VaultUtxo } from "../services/vault/types";

const MNEMONIC_A = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC_C = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

const ATTACKER_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const LEGIT_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

function rootFor(mnemonic: string): HDKey {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
}

function makeCosigner(mnemonic: string, name: string): Cosigner {
  return { ...deriveSelfCosigner(rootFor(mnemonic)), name };
}

function buildTestVault(): VaultConfig {
  return {
    id: "test-vault",
    name: "Test Vault",
    m: 2,
    n: 3,
    scriptType: "p2wsh",
    cosigners: [
      makeCosigner(MNEMONIC_A, "A"),
      makeCosigner(MNEMONIC_B, "B"),
      makeCosigner(MNEMONIC_C, "C"),
    ],
    createdAt: 0,
    schemaVersion: 1,
  };
}

// 工具：手工往 PSBT 加塞一个外部输出。返回修改后的 base64 PSBT。
function injectExtraOutput(
  psbtB64: string,
  extraAddress: string,
  extraSats: number,
): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtB64.trim()));
  tx.addOutputAddress(extraAddress, BigInt(extraSats), getBtcNetwork());
  return base64.encode(tx.toPSBT());
}

describe("signVaultPsbtSelf — output tampering defense (P0-1)", () => {
  it("signs a legitimate PSBT (1 external + 1 change)", () => {
    // #given
    const vault = buildTestVault();
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const utxo: VaultUtxo = {
      txid: "00".repeat(31) + "01",
      vout: 0,
      value: 100000,
      address: spendAddress,
      derivationIndex: 0,
      isChange: false,
    };
    const psbt = buildVaultPsbt({
      vault,
      inputs: [utxo],
      recipients: [{ address: LEGIT_ADDR, sats: 30000 }],
      changeIsChange: true,
      changeIndex: 0,
      feeRate: 10,
    });

    // #when
    const signed = signVaultPsbtSelf(psbt, vault, [utxo], rootFor(MNEMONIC_A));

    // #then — 签名成功且为非空 base64
    expect(signed.length).toBeGreaterThan(0);
    expect(signed).not.toBe(psbt);
  });

  it("throws when PSBT has 2 external outputs (attacker injected extra recipient)", () => {
    // #given
    const vault = buildTestVault();
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const utxo: VaultUtxo = {
      txid: "00".repeat(31) + "02",
      vout: 0,
      value: 100000,
      address: spendAddress,
      derivationIndex: 0,
      isChange: false,
    };
    const legitPsbt = buildVaultPsbt({
      vault,
      inputs: [utxo],
      recipients: [{ address: LEGIT_ADDR, sats: 30000 }],
      changeIsChange: true,
      changeIndex: 0,
      feeRate: 10,
    });
    // 攻击者注入第二个外部输出到自己的地址
    const tampered = injectExtraOutput(legitPsbt, ATTACKER_ADDR, 20000);

    // #when / #then
    expect(() =>
      signVaultPsbtSelf(tampered, vault, [utxo], rootFor(MNEMONIC_A)),
    ).toThrow(/PSBT outputs tampered.*found 2/);
  });

  it("accepts change output whose index is within SIGN_GAP_LIMIT", () => {
    // #given — 合法找零（change index = 3）落在 SIGN_GAP_LIMIT=20 之内
    const vault = buildTestVault();
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const utxo: VaultUtxo = {
      txid: "00".repeat(31) + "04",
      vout: 0,
      value: 200000,
      address: spendAddress,
      derivationIndex: 0,
      isChange: false,
    };
    const psbt = buildVaultPsbt({
      vault,
      inputs: [utxo],
      recipients: [{ address: LEGIT_ADDR, sats: 50000 }],
      changeIsChange: true,
      changeIndex: 3,
      feeRate: 10,
    });

    // #when
    const signed = signVaultPsbtSelf(psbt, vault, [utxo], rootFor(MNEMONIC_A));

    // #then
    expect(signed.length).toBeGreaterThan(0);
  });

  it("accepts high change index (15) within SIGN_GAP_LIMIT=20", () => {
    // #given — 找零 index = 15 验证 GAP 提升到 20 后的边界保护
    // （GAP=5 时会误判为外部输出而拒签）
    const vault = buildTestVault();
    const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    const utxo: VaultUtxo = {
      txid: "00".repeat(31) + "05",
      vout: 0,
      value: 500000,
      address: spendAddress,
      derivationIndex: 0,
      isChange: false,
    };
    const psbt = buildVaultPsbt({
      vault,
      inputs: [utxo],
      recipients: [{ address: LEGIT_ADDR, sats: 50000 }],
      changeIsChange: true,
      changeIndex: 15,
      feeRate: 10,
    });

    // #when
    const signed = signVaultPsbtSelf(psbt, vault, [utxo], rootFor(MNEMONIC_A));

    // #then
    expect(signed.length).toBeGreaterThan(0);
  });
});
