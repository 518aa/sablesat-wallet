// 气隙回程校验的回归测试。
//
// 【被修掉的缺陷】WatchOnlySendScreen 扫回已签 PSBT 后，一行校验都没有就进确认页，
// 而确认页显示的 recipient / amount 读的是**用户在表单里输入的 state**。
// 于是被掉包的离线设备、被替换的二维码，可以回传一笔收款方完全不同的已签交易，
// 在线端会显示你的原始意图、然后广播攻击者的交易。
//
// 离线签名的安全性建立在两步上：① 离线端只签它看得懂的东西 ② **在线端核对回传结果**。
// 缺了 ②，气隙就退化成"多按几次按钮"。
//
// 判据是 txid：隔离见证的 txid 按定义不含见证数据，所以签名不改变它；
// 反过来输入、输出、金额、sequence、locktime 任一被动过，txid 必变。

import * as btc from "@scure/btc-signer";
import { base64 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { assertSamePsbtTransaction, psbtTxid, signedInputCount } from "../services/transaction";
import { PsbtMismatchError } from "../services/psbtCommon";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PREV_TXID = "e6452a2cb71aa864aaa959e647e7a4726a22e640560f199f79b56b5502114c37";
const RECIPIENT = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ATTACKER = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
const child = root.derive("m/84'/0'/0'/0/0");
const pubkey = child.publicKey!;
const privkey = child.privateKey!;
const payment = btc.p2wpkh(pubkey, btc.NETWORK);

function buildPsbt(
  opts: { to?: string; amount?: bigint; changeSats?: bigint; sequence?: number } = {},
): string {
  const { to = RECIPIENT, amount = 90_000n, changeSats = 9_000n, sequence = 0xfffffffd } = opts;
  const tx = new btc.Transaction({});
  tx.addInput({
    txid: PREV_TXID,
    index: 0,
    sequence,
    witnessUtxo: { script: payment.script, amount: 100_000n },
    bip32Derivation: [
      [pubkey, { fingerprint: root.fingerprint >>> 0, path: [84 + 0x80000000, 0x80000000, 0x80000000, 0, 0] }],
    ],
  });
  tx.addOutputAddress(to, amount, btc.NETWORK);
  if (changeSats > 0n) tx.addOutputAddress(payment.address!, changeSats, btc.NETWORK);
  return base64.encode(tx.toPSBT());
}

function sign(psbtB64: string): string {
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtB64));
  tx.signIdx(privkey, 0);
  return base64.encode(tx.toPSBT());
}

const unsigned = buildPsbt();
const signed = sign(unsigned);

describe("核心不变量：隔离见证下签名不改变 txid", () => {
  it("已签 PSBT 与未签 PSBT 的 txid 相同", () => {
    expect(psbtTxid(signed)).toBe(psbtTxid(unsigned));
  });

  it("签名确实写进去了（不是没签就返回）", () => {
    expect(signed.length).toBeGreaterThan(unsigned.length);
    expect(signedInputCount(unsigned)).toBe(0);
    expect(signedInputCount(signed)).toBe(1);
  });

  it("finalize 之后 txid 依然不变（原生隔离见证，finalScriptSig 为空）", () => {
    const tx = btc.Transaction.fromPSBT(base64.decode(signed));
    tx.finalize();
    expect(tx.id).toBe(psbtTxid(unsigned));
  });
});

describe("篡改必须被拦下（气隙回程的全部意义）", () => {
  it("收款地址被换 —— 这就是那个能直接偷钱的场景", () => {
    expect(() => assertSamePsbtTransaction(unsigned, sign(buildPsbt({ to: ATTACKER })))).toThrow(
      PsbtMismatchError,
    );
  });

  it("收款金额被改", () => {
    expect(() => assertSamePsbtTransaction(unsigned, sign(buildPsbt({ amount: 95_000n })))).toThrow(
      PsbtMismatchError,
    );
  });

  it("找零被调小（把差额偷成矿工费）", () => {
    expect(() => assertSamePsbtTransaction(unsigned, sign(buildPsbt({ changeSats: 1_000n })))).toThrow(
      PsbtMismatchError,
    );
  });

  it("找零输出被整个删掉", () => {
    expect(() => assertSamePsbtTransaction(unsigned, sign(buildPsbt({ changeSats: 0n })))).toThrow(
      PsbtMismatchError,
    );
  });

  it("nSequence 被改（悄悄关掉 RBF，让用户无法加速）", () => {
    expect(() =>
      assertSamePsbtTransaction(unsigned, sign(buildPsbt({ sequence: 0xfffffffe }))),
    ).toThrow(PsbtMismatchError);
  });
});

describe("合法情形不能误杀", () => {
  it("正常签名回传通过", () => {
    expect(() => assertSamePsbtTransaction(unsigned, signed)).not.toThrow();
  });

  it("原样回传未签 PSBT 也算同一笔（由签名计数另行拦截）", () => {
    expect(() => assertSamePsbtTransaction(unsigned, unsigned)).not.toThrow();
    expect(signedInputCount(unsigned)).toBe(0);
  });
});

describe("signedInputCount 的空值陷阱", () => {
  // @scure 对未签输入给的是**空的** Uint8Array / 空数组，
  // 而 Boolean(new Uint8Array(0)) === true。写成真假判断会让未签 PSBT
  // 被算成已签，守卫永远不触发 —— 这条测试就是为了钉死这个坑。
  it("空的 finalScriptSig 不能被当成已签名", () => {
    expect(new Uint8Array(0)).toBeTruthy(); // 陷阱本身
    expect(signedInputCount(unsigned)).toBe(0);
  });
});
