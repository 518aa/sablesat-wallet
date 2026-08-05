// 本轮安全审计整改的回归测试。
//
// 每个 describe 对应一条被修掉的缺陷，测试名写清楚**旧实现的失败模式**——
// 这样将来有人想"优化"回去时，红灯会直接告诉他为什么不能。
//
// 另有一条元原则（见根因 3）：README / 注释里可验证的安全声明，应该以断言的
// 形式存在于测试里，而不是只写在文档中。gap limit 那一组就是这么写的。

import {
  checkFee,
  clampFeeRate,
  ExcessiveFeeError,
  MAX_FEE_RATE_ABSOLUTE,
  RATIO_GUARD_MIN_FEE_SATS,
} from "../services/feePolicy";
import { fanout, assertComplete, IncompleteDataError } from "../services/fanout";
import { GAP_LIMIT } from "../services/wallet";

// ───────────────────────────────────────────────────────────────────────────
describe("gap limit 契约（根因 3：文档声明必须可验证）", () => {
  it("必须 >= 20：README 声称扫描 0..n+20，旧实现却是 5", () => {
    // gap limit 低于 BIP44 规定的 20 时，导入外部钱包助记词会漏扫地址，
    // 表现为"链上有钱，App 显示余额不足"。这是互操作的硬性前提。
    expect(GAP_LIMIT).toBeGreaterThanOrEqual(20);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("手续费分级风控（旧实现 10% 一刀切会误杀正常交易）", () => {
  const vb = (i: number, o: number) => Math.ceil(i * 68 + o * 31 + 11);

  it("30000 sat UTXO 发 20000 @25 sat/vB 必须放行（旧实现 11.8% > 10% 被拒）", () => {
    const fee = Math.ceil(vb(1, 2) * 25); // 3525
    const verdict = checkFee({ inputSats: 30_000, outputSats: 30_000 - fee, vbytes: vb(1, 2) });
    expect(verdict.feeSats).toBe(fee);
    // 占比确实超过 10%，但费用绝对值很小，不是攻击特征 —— 只给 warning
    expect(verdict.feeSats / verdict.inputSats).toBeGreaterThan(0.1);
    expect(verdict.warnings).toContain("high-ratio");
  });

  it("归集 10 个 5000 sat UTXO 必须放行（旧实现 43% 被拒，用户无法整理 UTXO）", () => {
    const fee = Math.ceil(vb(10, 1) * 30);
    expect(() =>
      checkFee({ inputSats: 50_000, outputSats: 50_000 - fee, vbytes: vb(10, 1) }),
    ).not.toThrow();
  });

  it("费率超过绝对上限一律拒绝（这才是真正的硬边界）", () => {
    const vbytes = vb(1, 2);
    const fee = Math.ceil(vbytes * (MAX_FEE_RATE_ABSOLUTE + 1));
    expect(() =>
      checkFee({ inputSats: 100_000_000, outputSats: 100_000_000 - fee, vbytes }),
    ).toThrow(ExcessiveFeeError);
  });

  it("大额交易被抽走 >10% 仍然拒绝（攻击真正的形态）", () => {
    const fee = RATIO_GUARD_MIN_FEE_SATS * 2; // 100k sats，绝对值已经很大
    const inputSats = Math.floor(fee / 0.2); // 占比 20%
    expect(() => checkFee({ inputSats, outputSats: inputSats - fee, vbytes: 50_000 })).toThrow(
      ExcessiveFeeError,
    );
  });

  it("输出大于输入必须拒绝", () => {
    expect(() => checkFee({ inputSats: 1000, outputSats: 2000, vbytes: 200 })).toThrow(
      ExcessiveFeeError,
    );
  });

  it("单签与多签共用同一个钳制区间（旧实现多签钳 5000、签名端拒 500）", () => {
    // 造得出来就必须签得动：clamp 的上界不能高于 checkFee 的绝对上界。
    expect(clampFeeRate(99_999)).toBeLessThanOrEqual(MAX_FEE_RATE_ABSOLUTE);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("fanout 完整性语义（根因 1：消除 .catch(() => []) 静默降级）", () => {
  it("全部成功时 complete 为 true", async () => {
    const r = await fanout([1, 2, 3], async (n) => [n * 2]);
    expect(r.complete).toBe(true);
    expect(r.data.sort()).toEqual([2, 4, 6]);
    expect(r.failed).toBe(0);
  });

  it("部分失败时 complete 为 false，且成功的数据仍然返回", async () => {
    const r = await fanout([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("429 Too Many Requests");
      return [n];
    });
    expect(r.complete).toBe(false);
    expect(r.failed).toBe(1);
    expect(r.succeeded).toBe(2);
    expect(r.data.sort()).toEqual([1, 3]);
  });

  it("assertComplete 在数据不完整时抛错——发送路径绝不能用残缺的 UTXO 集合", async () => {
    const r = await fanout([1, 2], async (n) => {
      if (n === 2) throw new Error("boom");
      return [n];
    });
    expect(() => assertComplete(r)).toThrow(IncompleteDataError);
  });

  it("并发度受限，不会一次打出几十个请求（旧实现是无上限 Promise.all）", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    await fanout(
      items,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return [n];
      },
      6,
    );
    expect(peak).toBeLessThanOrEqual(6);
  });
});
