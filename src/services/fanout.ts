// ───────────────────────────────────────────────────────────────────────────
// 多地址扇出请求的**完整性语义** + 并发闸门。
//
// 【解决的根因】改之前 `.catch(() => [])` 这个模式散落在 5 个地方：
//   fetchAllWalletUtxos / fetchWalletState / scanWatchUtxos /
//   fetchStablecoinBalances / fetchUtxosForAddress
// 后果完全一致：部分地址请求失败（mempool.space 限流返回 429 是常态）→ 数据
// 不完整 → **余额少算、可花 UTXO 少算、自转检测失效**，而 UI 完全看不出区别。
//
// 对钱包来说「数据不完整」和「余额是零」是两件必须区分的事。前者应该禁用发送
// 并提示重试，后者才是"你没钱"。旧代码把前者悄悄降级成了后者。
//
// 这里把完整性做成**类型上无法忽略**的信息：调用方拿到的不是 T[]，而是
// FanoutResult<T>，想拿数据就必须面对 complete 字段。
//
// 顺带解决并发问题：旧的 fetchAllWalletUtxos 是无上限 Promise.all（gap limit
// 提到 20 之后就是 40+ 个地址同时打），scanWatchUtxos 更极端——完全串行，
// 12 次往返。这里统一走一个有界并发池。
// ───────────────────────────────────────────────────────────────────────────

export type FanoutResult<T> = {
  /** 成功部分的合并结果。complete 为 false 时这是**不完整**的数据。 */
  data: T[];
  /** 全部子请求都成功。false 时调用方必须禁用发送等破坏性操作。 */
  complete: boolean;
  succeeded: number;
  failed: number;
  total: number;
  /** 第一个失败原因，用于 UI 提示。 */
  firstError?: unknown;
};

/** 默认并发度。移动网络下再高收益递减，且更容易触发第三方 API 限流。 */
export const DEFAULT_FANOUT_CONCURRENCY = 6;

/**
 * 有界并发地对 items 逐个执行 task，收集结果并如实报告完整性。
 * **不吞异常**——失败会被计数并反映在 complete 上。
 */
export async function fanout<I, T>(
  items: readonly I[],
  task: (item: I) => Promise<T[]>,
  concurrency = DEFAULT_FANOUT_CONCURRENCY,
  /** 单个 item 失败后的自动重试次数（带退避）。发送路径用以提高网络抖动下的成功率。 */
  retryFailed = 0,
): Promise<FanoutResult<T>> {
  const data: T[] = [];
  let succeeded = 0;
  let failed = 0;
  let firstError: unknown;

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= items.length) return;
      // httpQueue 已对单请求做 3 次退避重试；这里给跨请求的额外机会，应对
      // 偶发超时 / 瞬时限流（重试时网络可能已恢复）。
      let lastErr: unknown;
      let done = false;
      for (let attempt = 0; attempt <= retryFailed; attempt++) {
        try {
          const chunk = await task(items[idx]);
          data.push(...chunk);
          succeeded++;
          done = true;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < retryFailed) {
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }
      if (!done) {
        failed++;
        if (firstError === undefined) firstError = lastErr;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    data,
    complete: failed === 0,
    succeeded,
    failed,
    total: items.length,
    firstError,
  };
}

/**
 * 数据不完整时抛出。用于**发送路径**——余额显示可以降级展示并加提示，
 * 但绝不能用一份不完整的 UTXO 集合去构造交易：
 *   - 少算的 UTXO 会让用户看到"余额不足"而实际有钱
 *   - 更糟的是自转检测（ownAddresses）不完整，可能把钱发给自己的另一个地址
 *     却被当成外部收款
 */
export class IncompleteDataError extends Error {
  constructor(
    public readonly failed: number,
    public readonly total: number,
    public readonly cause?: unknown,
  ) {
    super(
      `Incomplete wallet data: ${failed} of ${total} address queries failed. ` +
        `Refusing to build a transaction from a partial UTXO set.`,
    );
  }
}

export function assertComplete<T>(result: FanoutResult<T>): T[] {
  if (!result.complete) {
    throw new IncompleteDataError(result.failed, result.total, result.firstError);
  }
  return result.data;
}
