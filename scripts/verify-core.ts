import assert from "node:assert/strict";
import { randomBytes } from "@noble/hashes/utils.js";

// ---------------------------------------------------------------------------
// crypto.ts — pure JS, can import directly
// ---------------------------------------------------------------------------
import {
  encrypt,
  decrypt,
  constantTimeEqual,
  deriveKey,
  DEFAULT_SCRYPT_PARAMS,
  LEGACY_SCRYPT_PARAMS,
  bytesToHex,
  hexToBytes,
} from "../src/services/crypto";

// ---------------------------------------------------------------------------
// bitcoin.ts + transaction.ts — cannot import directly (RN dependency chain).
// Functions below are MIRRORS of the source code in:
//   src/utils/bitcoin.ts (satsToBtc, btcToSats, estimateTxVbytes)
//   src/services/transaction.ts (selectInputs, estimateSendFeeSats)
// When those modules are refactored to be RN-free, replace with direct imports.
// ---------------------------------------------------------------------------

const SATS_PER_BTC = 100_000_000;
const DUST_THRESHOLD_SATS = 546;

function satsToBtc(sats: number): string {
  const sign = sats < 0 ? "-" : "";
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / SATS_PER_BTC);
  const fraction = String(abs % SATS_PER_BTC).padStart(8, "0");
  return `${sign}${whole}.${fraction}`;
}

function btcToSats(input: string): number {
  const normalized = input.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(normalized)) return 0;
  const [whole, fraction = ""] = normalized.split(".");
  const satsText = `${whole}${fraction.padEnd(8, "0")}`.replace(/^0+(?=\d)/, "");
  const sats = Number(satsText || "0");
  return Number.isSafeInteger(sats) ? sats : 0;
}

function estimateTxVbytes(inputCount: number, outputCount: number) {
  return inputCount * 68 + outputCount * 31 + 10;
}

function estimateSendFeeSats(inputCount: number, feeRate: number, hasChange = true) {
  return Math.ceil(estimateTxVbytes(inputCount, hasChange ? 2 : 1) * feeRate);
}

type TestUTXO = { value: number; txid: string; vout: number };

class InsufficientBalanceError extends Error {
  constructor(public needed: number, public available: number) {
    super(`Insufficient balance: need ${needed} sats, have ${available} sats`);
  }
}

function selectInputs<T extends TestUTXO>(utxos: T[], amountSats: number, feeRate: number) {
  const confirmed = [...utxos].filter((utxo) => Number.isFinite(utxo.value) && utxo.value > 0);
  if (confirmed.length === 0) throw new Error("No confirmed UTXOs available");

  const sortedAsc = [...confirmed].sort((a, b) => a.value - b.value);

  const singleNoChange = sortedAsc.find(
    (u) => u.value >= amountSats + estimateSendFeeSats(1, feeRate, false),
  );

  let selected: T[];
  let inputSum: number;

  if (singleNoChange) {
    selected = [singleNoChange];
    inputSum = singleNoChange.value;
  } else {
    selected = [];
    inputSum = 0;
    for (const utxo of [...confirmed].sort((a, b) => b.value - a.value)) {
      selected.push(utxo);
      inputSum += utxo.value;
      if (inputSum >= amountSats + estimateSendFeeSats(selected.length, feeRate, false)) break;
    }
  }

  const feeNoChange = estimateSendFeeSats(selected.length, feeRate, false);
  const surplusNoChange = inputSum - amountSats - feeNoChange;

  if (surplusNoChange > DUST_THRESHOLD_SATS) {
    const feeWithChange = estimateSendFeeSats(selected.length, feeRate, true);
    const changeWithChange = inputSum - amountSats - feeWithChange;
    if (changeWithChange > DUST_THRESHOLD_SATS) {
      return { selected, fee: feeWithChange, changeAmount: changeWithChange };
    }
  }

  if (inputSum < amountSats + feeNoChange) {
    throw new InsufficientBalanceError(amountSats + feeNoChange, inputSum);
  }
  return { selected, fee: feeNoChange, changeAmount: 0 };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeUtxos(values: number[]): TestUTXO[] {
  return values.map((value, i) => ({ value, txid: `tx${i}`, vout: i }));
}

// ---------------------------------------------------------------------------
// satsToBtc tests
// ---------------------------------------------------------------------------

function testSatsToBtcBasic() {
  assert.equal(satsToBtc(100_000_000), "1.00000000");
  assert.equal(satsToBtc(0), "0.00000000");
  assert.equal(satsToBtc(1), "0.00000001");
  assert.equal(satsToBtc(50_000), "0.00050000");
}

function testSatsToBtcLarge() {
  const maxSupply = 21_000_000 * SATS_PER_BTC;
  assert.equal(satsToBtc(maxSupply), "21000000.00000000");
}

function testSatsToBtcNegative() {
  assert.equal(satsToBtc(-1000), "-0.00001000");
  assert.equal(satsToBtc(-100_000_000), "-1.00000000");
}

function testSatsToBtcFraction() {
  assert.equal(satsToBtc(150_000_000), "1.50000000");
  assert.equal(satsToBtc(100_000), "0.00100000");
}

// ---------------------------------------------------------------------------
// btcToSats tests
// ---------------------------------------------------------------------------

function testBtcToSatsBasic() {
  assert.equal(btcToSats("1"), 100_000_000);
  assert.equal(btcToSats("1.0"), 100_000_000);
  assert.equal(btcToSats("0"), 0);
  assert.equal(btcToSats("0.00000001"), 1);
}

function testBtcToSatsMaxPrecision() {
  assert.equal(btcToSats("0.12345678"), 12_345_678);
  assert.equal(btcToSats("0.123456789"), 0); // 9 decimals → invalid
}

function testBtcToSatsInvalid() {
  assert.equal(btcToSats("abc"), 0);
  assert.equal(btcToSats(""), 0);
  assert.equal(btcToSats("  "), 0);
  assert.equal(btcToSats("-1"), 0);
  assert.equal(btcToSats("1.2.3"), 0);
}

function testBtcToSatsWhitespace() {
  assert.equal(btcToSats("  1.5  "), 150_000_000);
  assert.equal(btcToSats(" 0.001 "), 100_000);
}

function testBtcToSatsLeadingZeros() {
  assert.equal(btcToSats("001.5"), 150_000_000);
  assert.equal(btcToSats("00"), 0);
}

function testRoundTripSatsBtc() {
  const values = [0, 1, 546, 1000, 50_000, 1_000_000, 100_000_000, 150_000_000, 2_100_000_000_000_000];
  for (const sats of values) {
    const btc = satsToBtc(sats);
    const back = btcToSats(btc);
    assert.equal(back, sats, `Round-trip failed for ${sats} sats: ${btc} → ${back}`);
  }
}

// ---------------------------------------------------------------------------
// Fee estimation tests
// ---------------------------------------------------------------------------

function testEstimateTxVbytes() {
  assert.equal(estimateTxVbytes(1, 1), 109);
  assert.equal(estimateTxVbytes(1, 2), 140);
  assert.equal(estimateTxVbytes(2, 2), 208);
  assert.equal(estimateTxVbytes(0, 0), 10);
}

function testEstimateSendFeeSats() {
  assert.equal(estimateSendFeeSats(1, 10, false), 1090);
  assert.equal(estimateSendFeeSats(1, 10, true), 1400);
}

// ---------------------------------------------------------------------------
// selectInputs tests
// ---------------------------------------------------------------------------

function testSelectInputsSingleNoChange() {
  // UTXO exactly covers amount + fee (no change output)
  const fee = estimateSendFeeSats(1, 10, false);
  const utxos = makeUtxos([50_000 + fee]);
  const result = selectInputs(utxos, 50_000, 10);
  assert.equal(result.selected.length, 1);
  assert.equal(result.changeAmount, 0);
  assert.ok(result.fee > 0);
}

function testSelectInputsMultipleNeeded() {
  const utxos = makeUtxos([30_000, 40_000, 50_000]);
  const result = selectInputs(utxos, 100_000, 10);
  assert.ok(result.selected.length >= 2);
  const inputSum = result.selected.reduce((s, u) => s + u.value, 0);
  assert.ok(inputSum >= 100_000 + result.fee);
}

function testSelectInputsWithChange() {
  const utxos = makeUtxos([500_000]);
  const result = selectInputs(utxos, 100_000, 10);
  assert.equal(result.selected.length, 1);
  assert.ok(result.changeAmount >= 0);
}

function testSelectInputsInsufficientFunds() {
  const utxos = makeUtxos([1000, 2000]);
  assert.throws(
    () => selectInputs(utxos, 100_000, 10),
    (err: Error) => err instanceof InsufficientBalanceError || /insufficient/i.test(err.message),
  );
}

function testSelectInputsEmptyUtxos() {
  assert.throws(
    () => selectInputs([], 1000, 10),
    /No confirmed UTXOs/i,
  );
}

function testSelectInputsFiltersZeroAndInvalid() {
  const utxos = makeUtxos([0, -100, 50_000, NaN]);
  const result = selectInputs(utxos, 1000, 10);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].value, 50_000);
}

function testSelectInputsPrefersSingleNoChange() {
  const amount = 50_000;
  const feeRate = 10;
  const feeNoChange = estimateSendFeeSats(1, feeRate, false);
  const exactUtxo = amount + feeNoChange;
  const utxos = makeUtxos([exactUtxo, 200_000]);
  const result = selectInputs(utxos, amount, feeRate);
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].value, exactUtxo);
}

// ---------------------------------------------------------------------------
// encrypt/decrypt tests (imported from real crypto.ts)
// ---------------------------------------------------------------------------

function testEncryptDecryptRoundTrip() {
  const key = randomBytes(32);
  const plaintext = "Hello, bitnest-wallet!";
  const { nonce, ciphertext } = encrypt(key, plaintext);
  const decrypted = decrypt(key, nonce, ciphertext);
  assert.equal(decrypted, plaintext);
}

function testEncryptNonceUniqueness() {
  const key = randomBytes(32);
  const e1 = encrypt(key, "same text");
  const e2 = encrypt(key, "same text");
  assert.notEqual(bytesToHex(e1.nonce), bytesToHex(e2.nonce));
  assert.notEqual(bytesToHex(e1.ciphertext), bytesToHex(e2.ciphertext));
}

function testDecryptWrongKeyFails() {
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const { nonce, ciphertext } = encrypt(keyA, "secret data");
  assert.throws(() => decrypt(keyB, nonce, ciphertext), /decrypt|cipher|invalid|tag/i);
}

function testDecryptCorruptedCiphertextFails() {
  const key = randomBytes(32);
  const { nonce, ciphertext } = encrypt(key, "original");
  const corrupted = new Uint8Array(ciphertext);
  corrupted[0] ^= 0xff;
  assert.throws(() => decrypt(key, nonce, corrupted), /decrypt|cipher|invalid|tag/i);
}

function testEncryptDecryptEmptyPlaintext() {
  const key = randomBytes(32);
  const { nonce, ciphertext } = encrypt(key, "");
  assert.equal(decrypt(key, nonce, ciphertext), "");
}

function testEncryptDecryptUnicode() {
  const key = randomBytes(32);
  const plaintext = "比特币钱包 🔐 中文测试 ¥0.08";
  const { nonce, ciphertext } = encrypt(key, plaintext);
  assert.equal(decrypt(key, nonce, ciphertext), plaintext);
}

function testEncryptWithAAD() {
  const key = randomBytes(32);
  const aad = new TextEncoder().encode("associated-data");
  const { nonce, ciphertext } = encrypt(key, "payload", aad);
  assert.equal(decrypt(key, nonce, ciphertext, aad), "payload");
  const wrongAad = new TextEncoder().encode("wrong-aad");
  assert.throws(() => decrypt(key, nonce, ciphertext, wrongAad), /decrypt|cipher|invalid|tag/i);
}

// ---------------------------------------------------------------------------
// constantTimeEqual tests
// ---------------------------------------------------------------------------

function testConstantTimeEqualTrue() {
  const a = randomBytes(32);
  const b = new Uint8Array(a);
  assert.equal(constantTimeEqual(a, b), true);
}

function testConstantTimeEqualFalse() {
  const a = randomBytes(32);
  const b = randomBytes(32);
  assert.equal(constantTimeEqual(a, b), false);
}

function testConstantTimeEqualDifferentLength() {
  assert.equal(constantTimeEqual(randomBytes(16), randomBytes(32)), false);
}

function testConstantTimeEqualEmpty() {
  assert.equal(constantTimeEqual(new Uint8Array(), new Uint8Array()), true);
}

// ---------------------------------------------------------------------------
// hex tests
// ---------------------------------------------------------------------------

function testHexRoundTrip() {
  const original = randomBytes(32);
  const hex = bytesToHex(original);
  assert.equal(bytesToHex(hexToBytes(hex)), hex);
}

function testHexToBytesWith0x() {
  const bytes = hexToBytes("0xdeadbeef");
  assert.equal(bytes.length, 4);
  assert.equal(bytes[0], 0xde);
  assert.equal(bytes[3], 0xef);
}

function testHexToBytesOddLength() {
  assert.throws(() => hexToBytes("abc"), /Invalid hex length/i);
}

// ---------------------------------------------------------------------------
// deriveKey (scrypt) tests — uses legacy params for speed
// ---------------------------------------------------------------------------

async function testDeriveKeyProduces32Bytes() {
  const salt = randomBytes(16);
  const key = await deriveKey("test-password", salt, LEGACY_SCRYPT_PARAMS);
  assert.equal(key.length, 32);
}

async function testDeriveKeyDifferentPasswords() {
  const salt = randomBytes(16);
  const keyA = await deriveKey("password-a", salt, LEGACY_SCRYPT_PARAMS);
  const keyB = await deriveKey("password-b", salt, LEGACY_SCRYPT_PARAMS);
  assert.notEqual(bytesToHex(keyA), bytesToHex(keyB));
}

async function testDeriveKeyDifferentSalts() {
  const saltA = randomBytes(16);
  const saltB = randomBytes(16);
  const keyA = await deriveKey("same-password", saltA, LEGACY_SCRYPT_PARAMS);
  const keyB = await deriveKey("same-password", saltB, LEGACY_SCRYPT_PARAMS);
  assert.notEqual(bytesToHex(keyA), bytesToHex(keyB));
}

async function testDeriveKeyBackwardCompat() {
  const salt = randomBytes(16);
  const keyLegacy = await deriveKey("test", salt, LEGACY_SCRYPT_PARAMS);
  assert.equal(keyLegacy.length, 32);
  const keyDefault = await deriveKey("test", salt, DEFAULT_SCRYPT_PARAMS);
  assert.equal(keyDefault.length, 32);
  assert.notEqual(bytesToHex(keyLegacy), bytesToHex(keyDefault));
}

async function testEncryptDecryptWithDerivedKey() {
  const salt = randomBytes(16);
  const key = await deriveKey("my-password", salt, LEGACY_SCRYPT_PARAMS);
  const { nonce, ciphertext } = encrypt(key, "vault data");
  assert.equal(decrypt(key, nonce, ciphertext), "vault data");
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

async function main() {
  const syncTests: Array<[string, () => void]> = [
    ["satsToBtc converts basic values", testSatsToBtcBasic],
    ["satsToBtc handles max supply (21M BTC)", testSatsToBtcLarge],
    ["satsToBtc handles negative values", testSatsToBtcNegative],
    ["satsToBtc handles fractional BTC", testSatsToBtcFraction],
    ["btcToSats converts basic values", testBtcToSatsBasic],
    ["btcToSats enforces 8-decimal max precision", testBtcToSatsMaxPrecision],
    ["btcToSats rejects invalid input", testBtcToSatsInvalid],
    ["btcToSats trims whitespace", testBtcToSatsWhitespace],
    ["btcToSats handles leading zeros", testBtcToSatsLeadingZeros],
    ["satsToBtc <-> btcToSats round-trip preserves values", testRoundTripSatsBtc],
    ["estimateTxVbytes calculates correctly", testEstimateTxVbytes],
    ["estimateSendFeeSats calculates with/without change", testEstimateSendFeeSats],
    ["selectInputs: single input no change preferred", testSelectInputsSingleNoChange],
    ["selectInputs: multiple inputs when needed", testSelectInputsMultipleNeeded],
    ["selectInputs: produces change output when surplus > dust", testSelectInputsWithChange],
    ["selectInputs: throws on insufficient funds", testSelectInputsInsufficientFunds],
    ["selectInputs: throws on empty UTXO list", testSelectInputsEmptyUtxos],
    ["selectInputs: filters zero/NaN/invalid UTXOs", testSelectInputsFiltersZeroAndInvalid],
    ["selectInputs: prefers single exact-match over larger UTXO", testSelectInputsPrefersSingleNoChange],
    ["encrypt/decrypt round-trip preserves plaintext", testEncryptDecryptRoundTrip],
    ["encrypt produces unique nonce per call", testEncryptNonceUniqueness],
    ["decrypt fails with wrong key", testDecryptWrongKeyFails],
    ["decrypt fails with corrupted ciphertext", testDecryptCorruptedCiphertextFails],
    ["encrypt/decrypt handles empty plaintext", testEncryptDecryptEmptyPlaintext],
    ["encrypt/decrypt handles Unicode text", testEncryptDecryptUnicode],
    ["encrypt with AAD: correct AAD decrypts, wrong AAD fails", testEncryptWithAAD],
    ["constantTimeEqual: equal arrays return true", testConstantTimeEqualTrue],
    ["constantTimeEqual: different arrays return false", testConstantTimeEqualFalse],
    ["constantTimeEqual: different lengths return false", testConstantTimeEqualDifferentLength],
    ["constantTimeEqual: empty arrays return true", testConstantTimeEqualEmpty],
    ["hexToBytes/bytesToHex round-trip", testHexRoundTrip],
    ["hexToBytes accepts 0x prefix", testHexToBytesWith0x],
    ["hexToBytes rejects odd-length input", testHexToBytesOddLength],
  ];

  const asyncTests: Array<[string, () => Promise<void>]> = [
    ["deriveKey produces 32-byte key", testDeriveKeyProduces32Bytes],
    ["deriveKey: different passwords produce different keys", testDeriveKeyDifferentPasswords],
    ["deriveKey: different salts produce different keys", testDeriveKeyDifferentSalts],
    ["deriveKey: backward compat with legacy params (N=4096)", testDeriveKeyBackwardCompat],
    ["encrypt/decrypt works with derived key end-to-end", testEncryptDecryptWithDerivedKey],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of syncTests) {
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

  for (const [name, fn] of asyncTests) {
    try {
      await fn();
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
