import { __testing } from "../services/logger";

const { redact } = __testing;

describe("log redaction", () => {
  it("redacts a BIP39 mnemonic in a string", () => {
    // 回归：旧规则覆盖地址/txid/pubkey/路径，唯独漏了助记词
    const out = redact(
      "restoring wallet abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about now",
    ) as string;
    expect(out).not.toContain("abandon");
    expect(out).toContain("[mnemonic]");
  });

  it("recurses into objects — the old version passed these through verbatim", () => {
    const out = redact({ level: 1, payload: { mnemonic: "secret words here" } }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(out)).not.toContain("secret words here");
    expect((out.payload as Record<string, unknown>).mnemonic).toBe("[redacted]");
  });

  it("recurses into arrays", () => {
    const out = redact([{ passphrase: "hunter2" }]) as unknown[];
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("never prints raw bytes (they may be key material)", () => {
    const out = redact(new Uint8Array([1, 2, 3, 4])) as string;
    expect(out).toBe("[bytes:4]");
  });

  it("redacts addresses, txids and extended keys", () => {
    expect(redact("sent to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toContain("[addr]");
    expect(redact("txid " + "a".repeat(64))).toContain("[hex64]");
    expect(
      redact(
        "key xpub6EF8jXqFeFEW5bwMU7RpQtHkzE4KJxcqJtvkCjJumzW8FPpfXjfgYuHqEuY2SKn3RhctPXCLzUAWLQ73zzcYcCptxYFdSFN25AZo3nBLGVn",
      ),
    ).toContain("[extkey]");
  });

  it("redacts an Error's message and stack", () => {
    const err = new Error("failed for bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    const out = redact(err) as { message: string };
    expect(out.message).toContain("[addr]");
  });

  it("stops at the depth limit instead of recursing forever", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      cur.next = {};
      cur = cur.next as Record<string, unknown>;
    }
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain("depth-limit");
  });
});
