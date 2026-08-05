import {
  btcToSatsOrNull,
  btcToSats,
  satsToBtc,
  parseBitcoinUri,
  clampFeeRate,
  InvalidAmountError,
} from "../utils/bitcoin";

jest.mock("../services/network-mode", () => ({
  getBtcNetwork: () => require("@scure/btc-signer").NETWORK,
  getNetworkModeSync: () => "mainnet",
}));

describe("btcToSats", () => {
  it("converts normal amounts", () => {
    expect(btcToSatsOrNull("1")).toBe(100_000_000);
    expect(btcToSatsOrNull("0.00000001")).toBe(1);
    expect(btcToSatsOrNull("1.5")).toBe(150_000_000);
    expect(btcToSatsOrNull(".5")).toBe(50_000_000);
  });

  it("returns null for invalid input instead of silently returning 0", () => {
    // 回归：旧实现对非法输入静默返回 0，UI 无法区分「无效」与「零金额」
    expect(btcToSatsOrNull("abc")).toBeNull();
    expect(btcToSatsOrNull("1.2.3")).toBeNull();
    expect(btcToSatsOrNull("-1")).toBeNull();
    expect(btcToSatsOrNull("0.000000001")).toBeNull(); // 超过 8 位小数
    expect(btcToSatsOrNull("")).toBeNull();
  });

  it("throws in the strict variant", () => {
    expect(() => btcToSats("abc")).toThrow(InvalidAmountError);
  });

  it("round-trips with satsToBtc", () => {
    for (const sats of [1, 546, 100_000_000, 123_456_789]) {
      expect(btcToSatsOrNull(satsToBtc(sats))).toBe(sats);
    }
  });
});

describe("clampFeeRate", () => {
  it("clamps out-of-range and non-finite values", () => {
    expect(clampFeeRate(0)).toBe(1);
    expect(clampFeeRate(-5)).toBe(1);
    expect(clampFeeRate(Number.NaN)).toBe(1);
    expect(clampFeeRate(99_999)).toBe(500);
    expect(clampFeeRate(12.4)).toBe(12);
  });
});

describe("parseBitcoinUri", () => {
  const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

  it("parses a bare address", () => {
    expect(parseBitcoinUri(ADDR)?.address).toBe(ADDR);
  });

  it("parses BIP21 with an amount", () => {
    const r = parseBitcoinUri(`bitcoin:${ADDR}?amount=0.001`);
    expect(r?.address).toBe(ADDR);
    expect(r?.amountSats).toBe(100_000);
  });

  it("rejects unknown req- parameters per BIP21", () => {
    expect(parseBitcoinUri(`bitcoin:${ADDR}?req-future=1`)).toBeNull();
  });

  it("rejects a malformed amount rather than ignoring it", () => {
    expect(parseBitcoinUri(`bitcoin:${ADDR}?amount=abc`)).toBeNull();
  });
});
