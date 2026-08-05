import { queuedFetch } from "./httpQueue";
import { getApiBase } from "./network-mode";
import { logger } from "./logger";

/** 单节点 failover：任一节点成功即返回。用于写操作与非关键读取。 */
export async function fetchBitcoinApi(
  path: string,
  init?: RequestInit,
  timeoutMs = 8000,
): Promise<Response> {
  let lastError: unknown = null;

  for (const node of getApiBase()) {
    try {
      // 经全局闸门：并发上限 + 429 退避重试 + 并发 GET 去重。
      // 旧实现直接 safeFetch，gap limit 提到 20 后一次刷新 80+ 请求齐发，
      // 必然被 mempool.space 限流。
      const res = await queuedFetch(`${node}${path}`, { ...(init ?? {}), timeoutMs });
      if (res.ok) return res;
      // 仅保留 HTTP status，不把响应 body 拼进错误消息——blockstream/mempool 的
      // 错误体常含 txid/地址，会沿调用链泄露到 UI 与日志。
      await res.text().catch(() => "");
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Network unavailable: ${lastError instanceof Error ? lastError.message : "all nodes failed"}`,
  );
}

export class SourceDisagreementError extends Error {
  constructor(public readonly path: string) {
    super(`Data sources disagree for ${path}; refusing to use possibly tampered data`);
  }
}

export type CrossCheckResult<T> = {
  value: T;
  /** 参与比对的节点数。1 表示只有一个节点可用（降级，未能交叉验证）。 */
  sources: number;
  agreed: boolean;
};

/**
 * 关键读取的双源交叉验证。
 *
 * 旧实现对余额 / UTXO 也是 failover——blockstream 成功就不问 mempool.space。
 * 这挡不住 MITM 最有价值的攻击：**隐瞒**。伪造余额变高没意义（花不出去），
 * 但隐藏一笔 UTXO 会让用户在不知情下少花，伪造一笔未确认入账会诱导用户发货。
 *
 * 证书固定同样能挡这类攻击，但本项目白名单里 13 个域名全是第三方，
 * pin 别人的证书意味着对方例行换证就会让钱包彻底失去联网能力。
 * 多源交叉验证的防护强度相当，且不会砖。
 */
export async function fetchBitcoinApiCrossChecked<T>(
  path: string,
  parse: (json: unknown) => T,
  normalize: (value: T) => string,
  timeoutMs = 8000,
): Promise<CrossCheckResult<T>> {
  const nodes = getApiBase();
  const settled = await Promise.allSettled(
    nodes.map(async (node) => {
      const res = await queuedFetch(`${node}${path}`, { timeoutMs });
      if (!res.ok) {
        await res.text().catch(() => "");
        throw new Error(`${res.status}`);
      }
      return parse(await res.json());
    }),
  );

  const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

  if (ok.length === 0) throw new Error(`Network unavailable for ${path}`);

  if (ok.length === 1) {
    // 只有一个节点可用：降级返回，但标记未交叉验证，UI 应提示"数据未经二次确认"。
    return { value: ok[0], sources: 1, agreed: false };
  }

  const fingerprints = ok.map(normalize);
  const agreed = fingerprints.every((f) => f === fingerprints[0]);
  if (!agreed) {
    // 不要静默选一个。调用方应提示用户"数据源不一致，请勿在此状态下发送交易"。
    logger.warn("Bitcoin API sources disagree", { path, sources: ok.length });
  }
  return { value: ok[0], sources: ok.length, agreed };
}
