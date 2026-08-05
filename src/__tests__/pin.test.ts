import { isWeakPin, validateNewPin, isValidPinFormat } from "../services/pin";

describe("PIN strength", () => {
  it("accepts a reasonable PIN", () => {
    for (const pin of ["481920", "739154", "20481937"]) {
      expect(validateNewPin(pin)).toBeNull();
    }
  });

  it("rejects sequential runs", () => {
    for (const pin of ["123456", "654321", "12345678", "87654321", "345678"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects repeated patterns", () => {
    for (const pin of ["121212", "123123", "111111", "12341234"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects PINs with too few distinct digits", () => {
    expect(isWeakPin("112211")).toBe(true);
    expect(isWeakPin("100000")).toBe(true);
  });

  it("enforces the format", () => {
    expect(isValidPinFormat("12345")).toBe(false); // 太短
    expect(isValidPinFormat("1234567890123")).toBe(false); // 太长
    expect(isValidPinFormat("12a456")).toBe(false); // 非数字
    expect(validateNewPin("12345")).toBe("format");
  });

  it("applies the same rules to the main PIN as to the duress PIN", () => {
    // 回归：旧实现只在胁迫 PIN 路径调用 isWeakPin，主 PIN 可以设成 123456
    expect(validateNewPin("123456")).toBe("weak");
  });
});
