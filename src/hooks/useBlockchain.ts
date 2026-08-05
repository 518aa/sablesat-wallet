import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  fetchBtcCnyPrice,
  fetchWalletState,
  getCachedWalletState,
  type ChainState,
} from "../services/blockchain";
import { scanWalletAddresses } from "../services/wallet";
import {
  getBlockchainMemoryCache,
  setBlockchainMemoryCache,
  getBlockchainInflight,
  setBlockchainInflight,
} from "../services/cache";
import { logger } from "../services/logger";

type BlockchainSnapshot = { chain: ChainState; price: number | null; fetchedAt: number };

const CACHE_TTL_MS = 30_000;
const PRICE_TTL_MS = 60_000;
let priceCache: { value: number | null; fetchedAt: number } | null = null;

// ---- singleton store: every caller shares one source of truth ----
// Previously HomeScreen and useAssets each instantiated useBlockchain(),
// producing two independent {chain, price, busy} states that updated at
// different times. The BalanceCard total (¥, from useAssets) and the BTC
// balance line (from HomeScreen) read two different `price` values, so values
// flickered on refresh. A module-level store fixes this: one refresh, one
// state, all subscribers re-render together.
type StoreState = { chain: ChainState | null; price: number | null; busy: boolean };
// Seed from `memoryCache` happens in the mount effect below; start empty here
// to avoid a type-narrowing pitfall when referencing memoryCache at init time.
let storeState: StoreState = { chain: null, price: null, busy: false };
const subscribers = new Set<() => void>();

function emit() {
  subscribers.forEach((l) => l());
}
function setStore(patch: Partial<StoreState>) {
  storeState = { ...storeState, ...patch };
  emit();
}
function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
const snapChain = () => storeState.chain;
const snapPrice = () => storeState.price;
const snapBusy = () => storeState.busy;

async function fetchSnapshot(force = false): Promise<BlockchainSnapshot> {
  const mc = getBlockchainMemoryCache() as BlockchainSnapshot | null;
  const inFlight = getBlockchainInflight() as Promise<BlockchainSnapshot> | null;
  if (!force && mc && Date.now() - mc.fetchedAt < CACHE_TTL_MS) {
    return mc;
  }
  if (!force && inFlight) return inFlight;

  const request = fetchWalletState().then((chain) => {
    const snapshot: BlockchainSnapshot = {
      chain,
      price: priceCache?.value ?? (getBlockchainMemoryCache() as BlockchainSnapshot | null)?.price ?? null,
      fetchedAt: Date.now(),
    };
    setBlockchainMemoryCache(snapshot);
    return snapshot;
  }).finally(() => {
    setBlockchainInflight(null);
  });

  setBlockchainInflight(request);
  return request;
}

async function fetchPrice(force = false) {
  if (!force && priceCache && Date.now() - priceCache.fetchedAt < PRICE_TTL_MS) {
    return priceCache.value;
  }
  const value = await fetchBtcCnyPrice();
  // value 为 null 表示所有价源都不可用 —— 不缓存 null，下次刷新重试。
  if (value === null) return priceCache?.value ?? null;
  priceCache = { value, fetchedAt: Date.now() };
  const mc = getBlockchainMemoryCache() as BlockchainSnapshot | null;
  if (mc) {
    setBlockchainMemoryCache({ ...mc, price: value });
  }
  return value;
}

// 清 singleton store 的 chain（主钱包余额/交易快照）。切换到胁迫钱包时调用，
// 防 HomeScreen remount 读到旧 chain 闪现主余额。price 保留（全局 BTC 价格，与钱包无关）。
export function resetBlockchainChain(): void {
  setStore({ chain: null });
}

export function useBlockchain() {
  const chain = useSyncExternalStore(subscribe, snapChain, snapChain);
  const price = useSyncExternalStore(subscribe, snapPrice, snapPrice);
  const busy = useSyncExternalStore(subscribe, snapBusy, snapBusy);

  const refresh = useCallback(async (force = true) => {
    setStore({ busy: true });
    try {
      const addrs = await scanWalletAddresses();
      const firstAddr = addrs[0]?.address;
      const cached = firstAddr ? await getCachedWalletState(firstAddr) : null;
      if (cached) setStore({ chain: cached });
      void fetchPrice(force)
        .then((p) => setStore({ price: p }))
        .catch((error) => {
          logger.warn("Failed to load BTC reference price", error);
        });
      const snapshot = await fetchSnapshot(force);
      setStore({ chain: snapshot.chain });
      if (snapshot.price) setStore({ price: snapshot.price });
    } catch (error) {
      logger.warn("Failed to refresh blockchain data", error);
    } finally {
      setStore({ busy: false });
    }
  }, []);

  useEffect(() => {
    const mc = getBlockchainMemoryCache() as BlockchainSnapshot | null;
    if (mc) {
      setStore({ chain: mc.chain, price: mc.price });
    }
    void refresh(false);
  }, [refresh]);

  return { chain, price, busy, refresh };
}
