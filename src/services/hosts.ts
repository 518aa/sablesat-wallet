const HOST_WHITELIST = new Set<string>([
  "lumis.tpr.wales",
  "blockstream.info",
  "mempool.space",
  "api.coinbase.com",
  "api.coingecko.com",
  "api.coinpaprika.com",
  "blockchain.info",
  "www.okx.com",
  "api.binance.com",
  "open.er-api.com",
  "bsc-dataseed.binance.org",
  "bsc.publicnode.com",
  "polygon-rpc.com",
  "polygon-bor.publicnode.com",
]);

// 响应体最大字节数（10 MB），防止恶意节点返回巨量数据耗尽内存。
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`Response body exceeds limit of ${limit} bytes`);
  }
}

export class DisallowedHostError extends Error {
  constructor(public readonly host: string) {
    super(`Network request to disallowed host: ${host}`);
  }
}

function assertHostAllowed(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new DisallowedHostError(parsed.protocol);
  }
  if (parsed.username || parsed.password) {
    throw new DisallowedHostError(parsed.host);
  }
  if (parsed.port !== "") {
    throw new DisallowedHostError(parsed.host);
  }
  const host = parsed.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new DisallowedHostError(host);
  }
  if (!HOST_WHITELIST.has(host)) {
    throw new DisallowedHostError(host);
  }
  return parsed;
}

export async function safeFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 9000
): Promise<Response> {
  assertHostAllowed(url);
  // ⚠️ `redirect: "manual"` 在 React Native 上**不生效**：底层是 OkHttp /
  // NSURLSession，会忽略该选项并自动跟随重定向。因此下面的 3xx 检查只在 Web
  // 端有意义，原生端拿不到中间跳转。
  //
  // 白名单本身仍然有效（首跳的 host 被校验），但「跨域重定向防护」这一层在原生
  // 端并不成立——不要依赖它。真正的防线是数据层自校验（见 network.ts 的
  // fetchBitcoinApiCrossChecked 与 blockchain.ts 的价格中位数）。
  // RN/Hermes 的 fetch 对 AbortSignal.timeout() 和 AbortController.abort() 支持
  // 都不稳定（真机实测 timeout 不触发，fetch 永久 hang → fanout 卡 →
  // previewSendTx 永不返回 → "一直估算中"转圈）。改用 Promise.race + setTimeout：
  // 不依赖 fetch 的 abort 机制，timeout 必定 reject，保证请求链不无限等待。
  // （fetch 在后台仍会继续直到自身完成/失败，但 race 已抛 timeout 让调用方继续。）
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = (await Promise.race([
      fetch(url, { ...init, redirect: "manual" }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fetch timeout ${timeoutMs}ms`)), timeoutMs);
      }),
    ])) as Response;
    if (res.status >= 300 && res.status < 400) {
      throw new DisallowedHostError(res.headers.get("location") ?? "redirect");
    }
    // 原生端兜底：最终 URL 若因自动跟随重定向落到白名单外，仍然拒绝。
    const finalUrl = (res as Response & { url?: string }).url;
    if (finalUrl) {
      try {
        assertHostAllowed(finalUrl);
      } catch {
        throw new DisallowedHostError(finalUrl);
      }
    }
    // 检查 Content-Length 头，提前拒绝过大响应
    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const len = Number(contentLength);
      if (Number.isFinite(len) && len > MAX_RESPONSE_BYTES) {
        throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
      }
    }
    // 包装响应体：读取时检查实际大小，防止 chunked encoding 绕过 Content-Length 检查
    const origArrayBuffer = res.arrayBuffer.bind(res);
    res.arrayBuffer = async () => {
      const buf = await origArrayBuffer();
      if (buf.byteLength > MAX_RESPONSE_BYTES) {
        throw new ResponseTooLargeError(MAX_RESPONSE_BYTES);
      }
      return buf;
    };
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
