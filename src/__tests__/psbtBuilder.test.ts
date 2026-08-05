// buildPsbtCore 回归测试（单签/watch-only 共用的 PSBT 构造骨架）。
// 验证 input/output 计数、找零 output 的 dust 门控——DRY 抽取后的等价性保障。
import { describe, it, expect } from "@jest/globals";
import { base64 } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { Transaction } from "@scure/btc-signer/transaction.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { buildPsbtCore, reviewPsbt, hasUnknownOutput, UNKNOWN_OUTPUT_ADDRESS } from "../services/transaction";
import { getBtcNetwork } from "../services/network-mode";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function deriveKeyPair(isChange: boolean, index: number) {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive(`m/84'/0'/0'/${isChange ? 1 : 0}/${index}`);
  if (!child.publicKey) throw new Error("missing pubkey");
  const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
  if (!payment.address || !payment.script) throw new Error("missing address/script");
  return { publicKey: child.publicKey, script: payment.script, address: payment.address };
}

describe("buildPsbtCore", () => {
  it("builds PSBT with recipient + change outputs", async () => {
    const kp = deriveKeyPair(false, 0);
    const changeKp = deriveKeyPair(true, 0);
    const utxo = { txid: "00".repeat(31) + "01", vout: 0, value: 100000, script: kp.script, address: kp.address };
    const result = await buildPsbtCore({
      recipient: kp.address,
      amountSats: 50000,
      selected: [utxo],
      changeAmount: 1000,
      changeAddress: changeKp.address,
      buildInput: (u) => ({ script: u.script, bip32Derivation: [[kp.publicKey, { fingerprint: 0xdeadbeef, path: [0] }]] }),
    });
    expect(result.inputCount).toBe(1);
    expect(result.psbtB64.length).toBeGreaterThan(0);
    const tx = Transaction.fromPSBT(base64.decode(result.psbtB64));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2); // recipient + change
  });

  it("omits change output when changeAmount <= dust", async () => {
    const kp = deriveKeyPair(false, 0);
    const utxo = { txid: "00".repeat(31) + "02", vout: 0, value: 100000, script: kp.script, address: kp.address };
    const result = await buildPsbtCore({
      recipient: kp.address,
      amountSats: 99000,
      selected: [utxo],
      changeAmount: 100, // < DUST_THRESHOLD_SATS (546)
      changeAddress: kp.address,
      buildInput: (u) => ({ script: u.script, bip32Derivation: [[kp.publicKey, { fingerprint: 0xdeadbeef, path: [0] }]] }),
    });
    const tx = Transaction.fromPSBT(base64.decode(result.psbtB64));
    expect(tx.outputsLength).toBe(1); // recipient only, change below dust dropped
  });

  it("omits change output when changeAddress is null", async () => {
    const kp = deriveKeyPair(false, 0);
    const utxo = { txid: "00".repeat(31) + "03", vout: 0, value: 100000, script: kp.script, address: kp.address };
    const result = await buildPsbtCore({
      recipient: kp.address,
      amountSats: 50000,
      selected: [utxo],
      changeAmount: 1000,
      changeAddress: null,
      buildInput: (u) => ({ script: u.script, bip32Derivation: [[kp.publicKey, { fingerprint: 0xdeadbeef, path: [0] }]] }),
    });
    const tx = Transaction.fromPSBT(base64.decode(result.psbtB64));
    expect(tx.outputsLength).toBe(1);
  });
});

describe("reviewPsbt sentinel (S-1)", () => {
  it("UNKNOWN_OUTPUT_ADDRESS is the sentinel string", () => {
    // #given / #when / #then — 验证 sentinel 是稳定的 "?" 字符串，便于 UI 检测
    expect(UNKNOWN_OUTPUT_ADDRESS).toBe("?");
  });

  it("hasUnknownOutput returns true when any output address is the sentinel", () => {
    // #given — 构造含 sentinel 的 review summary（模拟 reviewPsbt 在非标脚本时输出）
    const summary = {
      inputCount: 1,
      outputs: [
        { address: "bc1qabc", sats: 50000 },
        { address: UNKNOWN_OUTPUT_ADDRESS, sats: 1000 },
      ],
      feeSats: 1000,
    };

    // #when / #then
    expect(hasUnknownOutput(summary)).toBe(true);
  });

  it("hasUnknownOutput returns false when all outputs are known addresses", () => {
    // #given
    const summary = {
      inputCount: 1,
      outputs: [{ address: "bc1qabc", sats: 50000 }],
      feeSats: 1000,
    };

    // #when / #then
    expect(hasUnknownOutput(summary)).toBe(false);
  });

  it("returns known addresses for standard p2wpkh outputs", () => {
    // #given — 全部 p2wpkh 输出（正常路径）
    const kp = deriveKeyPair(false, 0);
    const utxo = { txid: "00".repeat(31) + "11", vout: 0, value: 100000, script: kp.script, address: kp.address };
    const tx = new btc.Transaction();
    tx.addInput({ txid: utxo.txid, index: 0, witnessUtxo: { script: utxo.script, amount: BigInt(utxo.value) } });
    tx.addOutputAddress(kp.address, BigInt(50000), getBtcNetwork());
    const psbtB64 = base64.encode(tx.toPSBT());

    // #when
    const summary = reviewPsbt(psbtB64);

    // #then
    expect(summary.outputs[0].address).toBe(kp.address);
    expect(hasUnknownOutput(summary)).toBe(false);
  });
});
