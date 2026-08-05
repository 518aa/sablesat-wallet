import { useCallback, useEffect, useState } from "react";
import { fetchStablecoinBalances, type StablecoinBalance } from "../services/evm";
import { getStablecoinCache } from "../services/cache";
import { logger } from "../services/logger";

const CACHE_TTL_MS = 30_000;

const cache = getStablecoinCache() as Map<string, { balances: StablecoinBalance[]; fetchedAt: number }>;

export function useStablecoins(evmAddress: string | undefined) {
  const initial = evmAddress ? cache.get(evmAddress) : undefined;
  const [balances, setBalances] = useState<StablecoinBalance[]>(initial?.balances ?? []);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBalances(evmAddress ? (cache.get(evmAddress)?.balances ?? []) : []);
  }, [evmAddress]);

  const refresh = useCallback(async (force = true) => {
    if (!evmAddress) return;
    const cached = cache.get(evmAddress);
    if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      setBalances(cached.balances);
      return;
    }
    setBusy(true);
    try {
      const next = await fetchStablecoinBalances(evmAddress);
      cache.set(evmAddress, { balances: next, fetchedAt: Date.now() });
      setBalances(next);
    } catch (error) {
      logger.warn("Failed to load stablecoin balances", error);
    } finally {
      setBusy(false);
    }
  }, [evmAddress]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return { balances, busy, refresh };
}
