import { clearCachedWalletState } from "./blockchain";

// ---- Stablecoin cache (moved from useStablecoins.ts) ----
const stablecoinCache = new Map<string, { balances: unknown[]; fetchedAt: number }>();

export function clearStablecoinCache(): void {
  stablecoinCache.clear();
}

export function getStablecoinCache(): Map<string, { balances: unknown[]; fetchedAt: number }> {
  return stablecoinCache;
}

// ---- Blockchain memory cache (moved from useBlockchain.ts) ----
let blockchainMemoryCache: unknown = null;
let blockchainInflight: unknown = null;

export async function invalidateBlockchainCache() {
  blockchainMemoryCache = null;
  blockchainInflight = null;
  await clearCachedWalletState();
}

export function getBlockchainMemoryCache(): unknown {
  return blockchainMemoryCache;
}
export function setBlockchainMemoryCache(v: unknown): void {
  blockchainMemoryCache = v;
}
export function getBlockchainInflight(): unknown {
  return blockchainInflight;
}
export function setBlockchainInflight(v: unknown): void {
  blockchainInflight = v;
}
