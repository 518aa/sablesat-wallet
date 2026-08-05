import { safeFetch } from "./hosts";
import { logger } from "./logger";

// ───────────────────────────────────────────────────────────────────────────
// 全局请求闸门：并发上限 + 退避重试 + in-flight 去重。
//
// 【根因 6】改之前的请求模型是 per-address fan-out，每次余额刷新 O(地址数 × 2)
// 个 HTTP 请求。gap limit 从 5 提到 20 之后，一次刷新是 80+ 个请求打向
// mempool.space —— 必然触发 429，然后被 `.catch(() => [])` 静默吞掉。
//
// 上一轮的 fanout 加了**每次调用内部**的并发上限，但多个 fanout 同时跑
// （余额刷新 + UTXO 扫描 + 观察钱包）仍会叠加。这里是**进程级**的闸门。
//
// 三件事：
//   1. 全局并发上限 —— 无论多少个调用点，同时在飞的请求数有上界
//   2. 429 / 503 退避重试 —— 尊重 Retry-After，指数退避 + 抖动
//   3. in-flight 去重 —— 同一个 GET URL 并发请求时合并成一次
//      （余额刷新和 UTXO 扫描会查同一批地址，去重能直接砍掉一半请求）
// ───────────────────────────────────────────────────────────────────────────

/** 进程级并发上限。第三方公共 API 对单 IP 都不宽容。国内电信网络下 8 并发
 * 容易触发 mempool/blockstream 限流（429），降到 4 减少限流概率，代价是批数变多。 */
const MAX_CONCURRENT = 4;

/** 重试策略。只对**幂等的 GET** 与明确的限流/网关错误重试。
 * 降到 1：国内限流时快速失败让 failover 接管下一源，避免单源 3 重试 × 退避
 * 累计几十秒、拖垮整批 fanout。偶发 429 由 failover 链兜底（多源任一可达即可）。 */
const MAX_RETRIES = 1;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/**
 * 持槽执行一次操作。**acquire / release 严格配对在同一个 try/finally 里**。
 *
 * 关键设计：退避 sleep 必须发生在**槽外**。如果占着并发槽睡觉，被限流时
 * 8 个槽会全部被睡眠中的请求占住，整个队列停摆——限流反而变成了自我拒绝服务。
 */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 退避时长。指数增长 + 随机抖动。
 *
 * 抖动不是可有可无的：40 个地址同时收到 429，如果退避时长一致，它们会在同一
 * 毫秒**一起**重试，第二波必然再次触发限流。这就是 thundering herd。
 */
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
  }
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exp / 2 + Math.random() * (exp / 2);
}

type QueuedInit = RequestInit & { timeoutMs?: number };

function isIdempotent(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

// in-flight GET 去重表。key 是完整 URL。
const inFlight = new Map<string, Promise<Response>>();

/**
 * 经闸门的 fetch。所有链上数据请求都应走这里，而不是直接调 safeFetch。
 *
 * ⚠️ 去重返回的是**同一个 Response 对象**。Response 的 body 只能读一次，
 * 所以去重路径必须 clone。这里统一 clone 后返回，调用方无需关心。
 */
export async function queuedFetch(url: string, init: QueuedInit = {}): Promise<Response> {
  const { timeoutMs = 8000, ...rest } = init;

  if (isIdempotent(rest)) {
    const existing = inFlight.get(url);
    // 合并并发的相同 GET：余额刷新与 UTXO 扫描会查同一批地址，
    // 去重能直接砍掉接近一半的请求量。
    if (existing) return (await existing).clone();
  }

  const retryable = isIdempotent(rest);

  const run = (async (): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        // 只有这一次网络往返占槽；下面的退避 sleep 在槽外进行。
        res = await withSlot(() => safeFetch(url, rest, timeoutMs));
      } catch (err) {
        lastError = err;
        if (!retryable || attempt >= MAX_RETRIES) throw err;
        await sleep(backoffMs(attempt, null));
        continue;
      }

      if (res.ok || !retryable || !RETRYABLE_STATUS.has(res.status) || attempt >= MAX_RETRIES) {
        return res;
      }

      // 可重试状态码：读掉 body 释放连接，再退避。
      const retryAfter = res.headers.get("retry-after");
      await res.text().catch(() => "");
      lastError = new Error(`HTTP ${res.status}`);
      const wait = backoffMs(attempt, retryAfter);
      logger.info("Retrying after backoff", {
        status: res.status,
        attempt,
        waitMs: Math.round(wait),
      });
      await sleep(wait);
    }
  })();

  if (retryable) {
    inFlight.set(url, run);
    void run.then(
      () => inFlight.delete(url),
      () => inFlight.delete(url),
    );
    return (await run).clone();
  }
  return run;
}

/** 仅供测试：重置闸门状态。 */
export function __resetHttpQueue(): void {
  active = 0;
  waiters.length = 0;
  inFlight.clear();
}
