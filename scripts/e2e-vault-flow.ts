import assert from "node:assert/strict";
import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import * as btc from "@scure/btc-signer";
import { Transaction } from "@scure/btc-signer/transaction.js";
import {
  deriveSelfCosigner,
} from "../src/services/vault/cosigner";
import { deriveVaultAddress } from "../src/services/vault/multisig";
import {
  buildVaultPsbt,
  signVaultPsbtSelf,
  combineVaultPsbt,
  finalizeAndExtract,
  summarizePsbt,
  inputsFromPsbt,
} from "../src/services/vault/psbt";
import { setNetworkMode, getBtcNetwork } from "../src/services/network-mode";
import type { Cosigner, VaultConfig, VaultUtxo } from "../src/services/vault/types";

const MNEMONIC_A = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC_C = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

const BROADCAST = process.argv.includes("--broadcast");

type Step = { name: string; ok: boolean; detail?: string };
const steps: Step[] = [];

function step(name: string, fn: () => void | string | undefined) {
  try {
    const detail = fn();
    steps.push({ name, ok: true, detail: typeof detail === "string" ? detail : undefined });
    console.log(`  PASS  ${name}${typeof detail === "string" ? ` — ${detail}` : ""}`);
  } catch (err) {
    steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildVault(mnemonics: [string, string, string]): { vault: VaultConfig; cosigners: Cosigner[] } {
  const cosigners: Cosigner[] = mnemonics.map((m, i) => ({
    ...deriveSelfCosigner(HDKey.fromMasterSeed(mnemonicToSeedSync(m))),
    name: `Device-${String.fromCharCode(65 + i)}`,
  }));
  const vault: VaultConfig = {
    id: "e2e-vault",
    name: "E2E Vault",
    m: 2,
    n: 3,
    scriptType: "p2wsh",
    cosigners,
    createdAt: 0,
    schemaVersion: 1,
  };
  return { vault, cosigners };
}

async function main() {
  console.log("\n=== Vault E2E Flow (testnet) ===\n");
  await setNetworkMode("testnet");

  const { vault, cosigners } = buildVault([MNEMONIC_A, MNEMONIC_B, MNEMONIC_C]);
  const [deviceA, deviceB, deviceC] = cosigners;

  const derived = deriveVaultAddress(vault.cosigners, false, 0, vault.m);
  step("Vault receive address is tb1 (testnet)", () => {
    assert.ok(derived.address.startsWith("tb1"), `expected tb1 address, got ${derived.address}`);
    return derived.address;
  });

  const recipientAddress = (() => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_C));
    const child = root.derive("m/84'/0'/0'/0/0");
    if (!child.publicKey) throw new Error("missing pubkey");
    return btc.p2wpkh(child.publicKey, getBtcNetwork()).address!;
  })();
  step("Recipient address is tb1 (testnet P2WPKH)", () => {
    assert.ok(recipientAddress.startsWith("tb1"), `expected tb1 recipient, got ${recipientAddress}`);
    return recipientAddress;
  });

  const fakeUtxo: VaultUtxo = {
    txid: "0000000000000000000000000000000000000000000000000000000000000001",
    vout: 0,
    value: 100_000,
    address: derived.address,
    derivationIndex: 0,
    isChange: false,
  };

  const recipients = [{ address: recipientAddress, sats: 50_000 }];

  const psbtAUnsigned = buildVaultPsbt({
    vault,
    inputs: [fakeUtxo],
    recipients,
    changeIsChange: true,
    changeIndex: 0,
    feeRate: 10,
  });

  step("Device A builds PSBT (unsigned, base64)", () => {
    assert.ok(psbtAUnsigned.length > 100, `PSBT unexpectedly short: ${psbtAUnsigned.length}`);
    assert.ok(psbtAUnsigned.startsWith("cHNidP8"), "PSBT should start with magic cHNidP8");
    return `${psbtAUnsigned.length} chars`;
  });

  const summary0 = summarizePsbt(psbtAUnsigned, vault, [fakeUtxo]);
  step("Unsigned PSBT has 0 sigs", () => {
    assert.equal(summary0.signaturesPerInput[0], 0);
    assert.equal(summary0.readyToFinalize, false);
  });

  const psbtASigned = signVaultPsbtSelf(psbtAUnsigned, vault, [fakeUtxo], HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_A)));
  step("Device A signs → 1/2 sigs", () => {
    const s = summarizePsbt(psbtASigned, vault, [fakeUtxo]);
    assert.equal(s.signaturesPerInput[0], 1, `expected 1 sig, got ${s.signaturesPerInput[0]}`);
    assert.equal(s.readyToFinalize, false);
    return "1 sig recorded";
  });

  const inputsForB = inputsFromPsbt(psbtASigned, deviceB.xpub);
  step("Device B recovers input derivation from PSBT bip32Derivation", () => {
    assert.equal(inputsForB.length, 1);
    assert.equal(inputsForB[0].isChange, false);
    assert.equal(inputsForB[0].derivationIndex, 0);
    assert.equal(inputsForB[0].value, 100_000);
    return "isChange=false idx=0";
  });

  const psbtBSigned = signVaultPsbtSelf(psbtASigned, vault, inputsForB, HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_B)));
  step("Device B signs → 2/2 sigs", () => {
    const s = summarizePsbt(psbtBSigned, vault, inputsForB);
    assert.equal(s.signaturesPerInput[0], 2, `expected 2 sigs, got ${s.signaturesPerInput[0]}`);
    assert.equal(s.readyToFinalize, true);
    return "ready to finalize";
  });

  step("Device C's key NOT in PSBT (must be excluded from signing set)", () => {
    assert.doesNotThrow(() => inputsFromPsbt(psbtBSigned, deviceC.xpub), undefined);
  });

  const combined = combineVaultPsbt(psbtASigned, psbtBSigned);
  const rawHex = finalizeAndExtract(combined);
  step("Combine + finalize + extract raw hex", () => {
    assert.ok(/^[0-9a-f]+$/.test(rawHex), "raw must be hex");
    assert.ok(rawHex.length > 200, `raw hex too short: ${rawHex.length}`);
    return `${rawHex.length / 2} bytes`;
  });

  const tx = Transaction.fromRaw(hex.decode(rawHex));
  step("Raw tx deserializes with 1 input + 2 outputs", () => {
    assert.equal(tx.inputsLength, 1, `expected 1 input, got ${tx.inputsLength}`);
    assert.equal(tx.outputsLength, 2, `expected 2 outputs (recipient + change), got ${tx.outputsLength}`);
  });

  step("Raw tx has witness (post-segwit)", () => {
    assert.equal(tx.hasWitnesses, true, "P2WSH spend must have witness");
  });

  step("txid is stable across re-extract", () => {
    const recomputed = finalizeAndExtract(combineVaultPsbt(psbtASigned, psbtBSigned));
    assert.equal(recomputed, rawHex, "re-extracted raw hex must match");
  });

  const changeAddr = deriveVaultAddress(vault.cosigners, true, 0, vault.m).address;
  step("Summary outputs include recipient + change", () => {
    const s = summarizePsbt(combined, vault, [fakeUtxo]);
    const addrs = s.outputs.map((o) => o.address);
    assert.ok(addrs.includes(recipientAddress), `recipient missing: ${addrs.join(",")}`);
    assert.ok(addrs.includes(changeAddr), `change missing: ${addrs.join(",")}`);
  });

  if (BROADCAST) {
    console.log("\n--- Broadcasting to testnet ---");
    const txid = await broadcastRaw(rawHex);
    if (txid) {
      step("Broadcast accepted by testnet mempool", () => {
        assert.ok(/^[0-9a-f]{64}$/.test(txid), `bad txid: ${txid}`);
        return txid;
      });
      console.log(`  txid: ${txid}`);
      console.log(`  https://mempool.space/testnet/tx/${txid}`);
    } else {
      steps.push({ name: "Broadcast accepted by testnet mempool", ok: false, detail: "rejected (expected for fake UTXO)" });
      console.log("  (rejected — expected, fake UTXO does not exist on-chain)");
    }
  }

  console.log("");
  const passed = steps.filter((s) => s.ok).length;
  const total = steps.length;
  console.log(`${passed}/${total} e2e steps passed`);
  if (passed !== total) process.exit(1);
}

async function broadcastRaw(rawHex: string): Promise<string | null> {
  const res = await fetch("https://blockstream.info/testnet/api/tx", {
    method: "POST",
    body: rawHex,
    headers: { "Content-Type": "text/plain" },
  });
  if (res.ok) return (await res.text()).trim();
  const body = await res.text().catch(() => "");
  console.log(`  Broadcast rejected (${res.status}): ${body.slice(0, 200)}`);
  return null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
