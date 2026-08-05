// 轻量 USD 行情：仅用于代币资产估值展示（非交易必需）。
// 走 CoinGecko 免 key 的 simple-price 接口，失败则优雅降级（返回 null）。
import { safeFetch } from "./hosts";
import { logger } from "./logger";

const CG_URL = "https://api.coingecko.com/api/v3/simple/price";
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { price: number; ts: number }>();

// coingecko id -> 我们内部的符号键
const ID_BY_SYMBOL: Record<string, string> = {
  bitcoin: "BTC",
  binancecoin: "BNB",
  "matic-network": "POL",
  "usd-coin": "USDC",
  "tether": "USDT",
};

export type PriceMap = Record<string, number>; // symbol -> usd

export async function fetchUsdPrices(ids: string[]): Promise<PriceMap> {
  const now = Date.now();
  const missing = ids.filter((id) => {
    const c = cache.get(id);
    return !c || now - c.ts > CACHE_TTL_MS;
  });
  if (missing.length > 0) {
    try {
      const url = `${CG_URL}?ids=${missing.join(",")}&vs_currencies=usd`;
      const res = await safeFetch(url, { method: "GET" }, 10000);
      if (res.ok) {
        const json = (await res.json()) as Record<string, { usd: number }>;
        for (const [id, val] of Object.entries(json)) {
          if (typeof val?.usd === "number") cache.set(id, { price: val.usd, ts: now });
        }
      }
    } catch (error) {
      logger.warn("Failed to load USD prices", error);
    }
  }
  const out: PriceMap = {};
  for (const id of ids) {
    const c = cache.get(id);
    if (c) out[ID_BY_SYMBOL[id] ?? id] = c.price;
  }
  return out;
}

// 稳定币近似 $1，无需联网。
function stablecoinUsd(): number {
  return 1;
}
