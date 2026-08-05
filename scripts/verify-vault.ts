import assert from "node:assert/strict";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import { hex, base64, base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { Transaction } from "@scure/btc-signer/transaction.js";
import {
  deriveSelfCosigner,
  deriveSelfPrivateKeyAt,
  cosignerInputDerivation,
} from "../src/services/vault/cosigner";
import { parseBip32Path } from "../src/services/wallet";
import { parseExtKey } from "../src/services/extkey";
import { sortedPubkeys, deriveVaultAddress } from "../src/services/vault/multisig";
import {
  buildVaultPsbt,
  signVaultPsbtSelf,
  combineVaultPsbt,
  finalizeAndExtract,
  summarizePsbt,
  inputsFromPsbt,
} from "../src/services/vault/psbt";
import type { Cosigner, VaultConfig, VaultUtxo } from "../src/services/vault/types";

const MNEMONIC_A = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_B = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const MNEMONIC_C = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

const SELF_DERIVATION_PATH = "m/48'/0'/0'/2'";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function makeCosigner(mnemonic: string, name: string): Cosigner {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
  return { ...deriveSelfCosigner(root), name };
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

function testBip67Sort() {
  const pubkeysHex = [
    "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd",
    "03b287eaf122eea69030d0d85dace891ff7c86c439b001d6c3a81bf7aa6ccb6d23",
    "024ce9c8d4c5c8c9d8a8b7c6a5b4c3d2e1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5",
  ];
  const expectedSorted = [...pubkeysHex].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pubkeys = pubkeysHex.map((h) => hex.decode(h));
  const sorted = sortedPubkeys(pubkeys);
  const sortedHex = sorted.map((p) => hex.encode(p));

  assert.equal(sortedHex.length, 3, "BIP67 should return 3 pubkeys");
  for (let i = 0; i < expectedSorted.length; i++) {
    assert.equal(sortedHex[i], expectedSorted[i], `BIP67 mismatch at index ${i}`);
  }
}

function testAddressOrderIndependence() {
  const a = makeCosigner(MNEMONIC_A, "A");
  const b = makeCosigner(MNEMONIC_B, "B");
  const c = makeCosigner(MNEMONIC_C, "C");

  const orders: Cosigner[][] = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];

  const addresses = new Set<string>();
  const witnessScripts = new Set<string>();
  for (const order of orders) {
    const vault = buildTestVault(order);
    const { address, witnessScript } = deriveVaultAddress(vault.cosigners, false, 0, 2);
    addresses.add(address);
    witnessScripts.add(hex.encode(witnessScript));
  }

  assert.equal(addresses.size, 1, `Address should be invariant under cosigner permutation, got: ${[...addresses].join(", ")}`);
  assert.equal(witnessScripts.size, 1, `Witness script should be invariant under cosigner permutation`);
}

function testAddressIsBech32() {
  const cosigners = [makeCosigner(MNEMONIC_A, "A"), makeCosigner(MNEMONIC_B, "B"), makeCosigner(MNEMONIC_C, "C")];
  const vault = buildTestVault(cosigners);
  const { address } = deriveVaultAddress(vault.cosigners, false, 0, 2);
  assert.ok(address.startsWith("bc1"), `Expected mainnet bech32 address, got: ${address}`);
  assert.ok(address.length >= 39 && address.length <= 62, `P2WSH address length out of range: ${address.length}`);
}

function testSelfPrivateKeyMatchesXpub() {
  const privRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_A));
  const derived = deriveSelfCosigner(privRoot);
  const privChild = privRoot.derive(`${SELF_DERIVATION_PATH}/0/0`);
  if (!privChild.privateKey || !privChild.publicKey) throw new Error("missing key material");

  const xpubAccount = HDKey.fromExtendedKey(derived.xpub);
  const xpubChild = xpubAccount.derive("m/0/0");
  if (!xpubChild.publicKey) throw new Error("missing xpub child pubkey");

  const privFromFn = deriveSelfPrivateKeyAt(privRoot, false, 0);
  const privChildPubHex = hex.encode(privChild.publicKey);
  const xpubChildPubHex = hex.encode(xpubChild.publicKey);

  assert.equal(privChildPubHex, xpubChildPubHex, "privkey-derived pubkey must match xpub-derived pubkey");

  privFromFn.fill(0);
}

function testPsbtRoundTrip() {
  const a = makeCosigner(MNEMONIC_A, "A");
  const b = makeCosigner(MNEMONIC_B, "B");
  const c = makeCosigner(MNEMONIC_C, "C");
  const vault = buildTestVault([a, b, c]);

  const rootA = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_A));
  const rootB = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_B));
  const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);
  const { address: changeAddress } = deriveVaultAddress(vault.cosigners, true, 0, 2);

  const fakeUtxo: VaultUtxo = {
    txid: "0000000000000000000000000000000000000000000000000000000000000001",
    vout: 0,
    value: 100000,
    address: spendAddress,
    derivationIndex: 0,
    isChange: false,
  };

  const recipients = [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }];
  const unsignedPsbt = buildVaultPsbt({
    vault,
    inputs: [fakeUtxo],
    recipients,
    changeIsChange: true,
    changeIndex: 0,
    feeRate: 10,
  });

  assert.ok(unsignedPsbt.length > 0, "PSBT should be non-empty base64");
  assert.ok(unsignedPsbt.length < 1200, `Unsigned PSBT unexpectedly large: ${unsignedPsbt.length}`);

  const summary0 = summarizePsbt(unsignedPsbt, vault, [fakeUtxo]);
  assert.equal(summary0.signaturesPerInput[0], 0, "Unsigned PSBT should have 0 sigs");
  assert.equal(summary0.inputs.length, 1);
  assert.equal(summary0.outputs.length, 2, "should have recipient + change");

  const signedByA = signVaultPsbtSelf(unsignedPsbt, vault, [fakeUtxo], rootA);
  const summary1 = summarizePsbt(signedByA, vault, [fakeUtxo]);
  assert.equal(summary1.signaturesPerInput[0], 1, `expected 1 sig after A signs, got ${summary1.signaturesPerInput[0]}`);
  assert.equal(summary1.readyToFinalize, false, "should not be ready with only 1 of 2 sigs");

  const signedByB = signVaultPsbtSelf(unsignedPsbt, vault, [fakeUtxo], rootB);
  const combined = combineVaultPsbt(signedByA, signedByB);
  const summary2 = summarizePsbt(combined, vault, [fakeUtxo]);
  assert.equal(summary2.signaturesPerInput[0], 2, `expected 2 sigs after combine, got ${summary2.signaturesPerInput[0]}`);
  assert.equal(summary2.readyToFinalize, true, "should be ready to finalize with 2 of 2 sigs");

  const rawHex = finalizeAndExtract(combined);
  assert.ok(/^[0-9a-f]+$/.test(rawHex), "extracted tx should be hex");
  assert.ok(rawHex.length > 100, `raw tx hex suspiciously short: ${rawHex.length}`);

  const recomputed = combineVaultPsbt(signedByB, signedByA);
  const rawHex2 = finalizeAndExtract(recomputed);
  assert.equal(rawHex, rawHex2, "combine/finalize should be order-independent");
}

function testInsufficientFunds() {
  const a = makeCosigner(MNEMONIC_A, "A");
  const b = makeCosigner(MNEMONIC_B, "B");
  const c = makeCosigner(MNEMONIC_C, "C");
  const vault = buildTestVault([a, b, c]);
  const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);

  const fakeUtxo: VaultUtxo = {
    txid: "0000000000000000000000000000000000000000000000000000000000000001",
    vout: 0,
    value: 1000,
    address: spendAddress,
    derivationIndex: 0,
    isChange: false,
  };

  assert.throws(
    () =>
      buildVaultPsbt({
        vault,
        inputs: [fakeUtxo],
        recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
        changeIsChange: true,
        changeIndex: 0,
        feeRate: 10,
      }),
    /Insufficient funds/,
    "should reject when input < output + fee",
  );
}

function testParseDerivationPath() {
  const segs = parseBip32Path("m/48'/0'/0'/2'");
  assert.deepEqual(segs, [0x80000030, 0x80000000, 0x80000000, 0x80000002]);
  assert.deepEqual(parseBip32Path("m/0/1/2"), [0, 1, 2]);
  assert.deepEqual(parseBip32Path("m/84'/0'/0'/0/0"), [0x80000054, 0x80000000, 0x80000000, 0, 0]);
}

function testBip32DerivationRoundTrip() {
  const a = makeCosigner(MNEMONIC_A, "A");
  const b = makeCosigner(MNEMONIC_B, "B");
  const c = makeCosigner(MNEMONIC_C, "C");
  const vault = buildTestVault([a, b, c]);
  const { address: spendAddress } = deriveVaultAddress(vault.cosigners, false, 0, 2);

  const fakeUtxo: VaultUtxo = {
    txid: "0000000000000000000000000000000000000000000000000000000000000001",
    vout: 0,
    value: 100000,
    address: spendAddress,
    derivationIndex: 0,
    isChange: false,
  };

  const unsignedPsbt = buildVaultPsbt({
    vault,
    inputs: [fakeUtxo],
    recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
    changeIsChange: true,
    changeIndex: 0,
    feeRate: 10,
  });

  const tx = Transaction.fromPSBT(base64.decode(unsignedPsbt));
  const input = tx.getInput(0);
  assert.ok(input.bip32Derivation, "PSBT input missing bip32Derivation");
  assert.equal(input.bip32Derivation.length, 3, "expected 3 derivation entries (one per cosigner)");

  type Bip32DerivationEntry = [Uint8Array, { fingerprint: number; path: number[] }];
  for (const cosigner of vault.cosigners) {
    const expected = cosignerInputDerivation(cosigner, false, 0);
    const expectedHex = hex.encode(expected.pubkey);
    const match: Bip32DerivationEntry | undefined = input.bip32Derivation!.find(
      ([pk]: Bip32DerivationEntry) => hex.encode(pk) === expectedHex,
    );
    assert.ok(match, `PSBT missing bip32Derivation for cosigner pubkey ${expectedHex}`);
    assert.equal(match![1].fingerprint, expected.fingerprint);
    assert.deepEqual(match![1].path, expected.path);
  }

  const selfCosigner = vault.cosigners.find((c) => c.role === "self")!;
  const recovered = inputsFromPsbt(unsignedPsbt, selfCosigner.xpub);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].isChange, false);
  assert.equal(recovered[0].derivationIndex, 0);
}

function testZpubImportRoundTrip() {
  // Produce a genuine zpub the same way the app exports it (xpub re-serialized
  // with zpub version bytes), then prove the tolerant parser accepts it and
  // derives byte-identical pubkeys to the underlying xpub.
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC_A));
  const account = root.derive("m/84'/0'/0'");
  const xpub = account.publicExtendedKey!;
  const zpub = xpubToZpubInTest(xpub);
  assert.ok(zpub.startsWith("zpub"), "sanity: produced a zpub-prefixed key");

  const zAccount = parseExtKey(zpub);
  const xAccount = parseExtKey(xpub);
  assert.ok(zAccount.publicKey, "parseExtKey must accept a real zpub (was 'zpub 格式无效')");
  assert.ok(
    bytesEqual(zAccount.derive("m/0/0").publicKey!, xAccount.derive("m/0/0").publicKey!),
    "zpub receive[0] must equal xpub receive[0]",
  );
  assert.ok(
    bytesEqual(zAccount.derive("m/1/7").publicKey!, xAccount.derive("m/1/7").publicKey!),
    "zpub change[7] must equal xpub change[7]",
  );
}

// Mirror wallet.ts's xpubToZpub: swap the 4-byte version prefix (xpub
// 0x0488B21E → zpub 0x04B24746) and recompute the base58check checksum.
function xpubToZpubInTest(xpub: string): string {
  const decoded = base58.decode(xpub);
  if (decoded.length !== 82) throw new Error("Invalid xpub length");
  const payload = new Uint8Array(78);
  payload[0] = 0x04;
  payload[1] = 0xb2;
  payload[2] = 0x47;
  payload[3] = 0x46;
  payload.set(decoded.slice(4, 78), 4);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  const full = new Uint8Array(82);
  full.set(payload, 0);
  full.set(checksum, 78);
  return base58.encode(full);
}

function testInputsFromPsbtHandlesChangeAndNonzeroIndex() {
  // Regression test for the multisig cosign bug: inputsFromPsbt previously only
  // matched a single fixed pubkey (receive index 0), so any vault tx spending a
  // change output or a nonzero receive index was rejected on the cosigning device.
  const a = makeCosigner(MNEMONIC_A, "A");
  const b = makeCosigner(MNEMONIC_B, "B");
  const c = makeCosigner(MNEMONIC_C, "C");
  const vault = buildTestVault([a, b, c]);
  const { address: r0 } = deriveVaultAddress(vault.cosigners, false, 0, 2);
  const { address: c3 } = deriveVaultAddress(vault.cosigners, true, 3, 2);

  const in1: VaultUtxo = {
    txid: "00000000000000000000000000000000000000000000000000000000000000a1",
    vout: 0,
    value: 100000,
    address: r0,
    derivationIndex: 0,
    isChange: false,
  };
  const in2: VaultUtxo = {
    txid: "00000000000000000000000000000000000000000000000000000000000000a2",
    vout: 1,
    value: 50000,
    address: c3,
    derivationIndex: 3,
    isChange: true,
  };

  const unsigned = buildVaultPsbt({
    vault,
    inputs: [in1, in2],
    recipients: [{ address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", sats: 50000 }],
    changeIsChange: true,
    changeIndex: 0,
    feeRate: 10,
  });

  const self = vault.cosigners.find((c) => c.role === "self")!;
  const recovered = inputsFromPsbt(unsigned, self.xpub);
  assert.equal(recovered.length, 2, "should recover both inputs");
  const byKey = new Map(recovered.map((u) => [`${u.isChange}:${u.derivationIndex}`, u]));
  assert.ok(byKey.get("false:0"), "should recover receive index 0");
  assert.ok(byKey.get("true:3"), "should recover change index 3 (the fixed bug rejected this)");
  assert.equal(byKey.get("true:3")!.value, 50000, "change input value preserved");
}

async function main() {
  const tests: Array<[string, () => void]> = [
    ["BIP67 lexicographic sort", testBip67Sort],
    ["Address invariance under cosigner permutation", testAddressOrderIndependence],
    ["Derived address is bech32 P2WSH", testAddressIsBech32],
    ["Self private key derives same pubkey as xpub", testSelfPrivateKeyMatchesXpub],
    ["PSBT build → sign A → sign B → combine → finalize → extract", testPsbtRoundTrip],
    ["Insufficient funds rejection", testInsufficientFunds],
    ["parseDerivationPath parses hardened + soft segments", testParseDerivationPath],
    ["PSBT embeds bip32Derivation and inputsFromPsbt recovers path", testBip32DerivationRoundTrip],
    ["zpub import round-trips through tolerant parser", testZpubImportRoundTrip],
    ["inputsFromPsbt recovers change and nonzero receive inputs", testInputsFromPsbtHandlesChangeAndNonzeroIndex],
  ];

  let passed = 0;
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`  PASS  ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }
  console.log("");
  console.log(`${passed}/${passed + failed} tests passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
