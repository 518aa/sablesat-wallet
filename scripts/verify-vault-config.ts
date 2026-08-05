import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils.js";
import { encodeVaultBlob, decodeVaultBlob } from "../src/services/vault/encoding";
import type { VaultConfig } from "../src/services/vault/types";

function makeVault(id: string, name: string): VaultConfig {
  return {
    id,
    name,
    m: 2,
    n: 3,
    scriptType: "p2wsh",
    cosigners: [
      { role: "self", name: "A", xpub: "xpubAAA", derivationPath: "m/48'/0'/0'/2'", fingerprint: "deadbeef" },
      { role: "external", name: "B", xpub: "xpubBBB", derivationPath: "m/48'/0'/0'/2'", fingerprint: "cafef00d" },
      { role: "external", name: "C", xpub: "xpubCCC", derivationPath: "m/48'/0'/0'/2'", fingerprint: "feedface" },
    ],
    createdAt: Date.now(),
    schemaVersion: 1,
  };
}

function testRoundTripPreservesVaults() {
  const key = randomBytes(32);
  const list = [makeVault("v1", "Vault 1"), makeVault("v2", "Vault 2")];
  const blob = encodeVaultBlob(list, key);
  const decoded = decodeVaultBlob(blob, key);

  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].id, "v1");
  assert.equal(decoded[1].name, "Vault 2");
  assert.deepEqual(decoded[0].cosigners, list[0].cosigners);
}

function testCiphertextIsNotPlaintext() {
  const key = randomBytes(32);
  const list = [makeVault("v1", "Secret Vault Name")];
  const blob = encodeVaultBlob(list, key);

  assert.ok(!blob.includes("Secret Vault Name"), "Plaintext leaked into ciphertext blob");
  assert.ok(!blob.includes("xpubAAA"), "xpub leaked into ciphertext blob");
}

function testNonceIsUnique() {
  const key = randomBytes(32);
  const list = [makeVault("v1", "V")];
  const blob1 = JSON.parse(encodeVaultBlob(list, key));
  const blob2 = JSON.parse(encodeVaultBlob(list, key));

  assert.notEqual(blob1.nonceB64, blob2.nonceB64, "Nonce reused across encryptions");
}

function testCorruptedCiphertextRejects() {
  const key = randomBytes(32);
  const list = [makeVault("v1", "V")];
  const blob = JSON.parse(encodeVaultBlob(list, key));

  const corruptedCipher = btoa(
    atob(blob.ciphertextB64)
      .split("")
      .map((ch, i) => (i === 0 ? String.fromCharCode(ch.charCodeAt(0) ^ 0xff) : ch))
      .join(""),
  );
  const corrupted = JSON.stringify({ ...blob, ciphertextB64: corruptedCipher });

  assert.throws(() => decodeVaultBlob(corrupted, key), /decrypt|cipher|invalid|tag/i);
}

function testWrongKeyRejects() {
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const list = [makeVault("v1", "V")];
  const blob = encodeVaultBlob(list, keyA);

  assert.throws(() => decodeVaultBlob(blob, keyB), /decrypt|cipher|invalid|tag/i);
}

function testEmptyListRoundTrip() {
  const key = randomBytes(32);
  const blob = encodeVaultBlob([], key);
  const decoded = decodeVaultBlob(blob, key);
  assert.equal(decoded.length, 0);
}

async function main() {
  const tests: Array<[string, () => void]> = [
    ["Encode/decode round-trip preserves vault list", testRoundTripPreservesVaults],
    ["Ciphertext blob contains no plaintext identifiers", testCiphertextIsNotPlaintext],
    ["Nonce is unique per encryption", testNonceIsUnique],
    ["Corrupted ciphertext is rejected", testCorruptedCiphertextRejects],
    ["Wrong key is rejected", testWrongKeyRejects],
    ["Empty list round-trips cleanly", testEmptyListRoundTrip],
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
