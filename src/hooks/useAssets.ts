import { useCallback, useEffect, useState } from "react";
import { useBlockchain } from "./useBlockchain";
import {
  loadCustomTokens,
  allAssets,
  chainGroups,
  type AssetDef,
  type ChainId,
  type CustomToken,
} from "../chains/tokens";
import { fetchNativeBalance, fetchErc20BalanceFor } from "../services/evm";
import { fetchUsdPrices } from "../services/prices";
import { satsToBtc, SATS_PER_BTC } from "../utils/bitcoin";
import { logger } from "../services/logger";

export type AssetView = {
  asset: AssetDef;
  rawBalance: bigint;
  displayBalance: string;
  usd: number;
};

export type UseAssetsResult = {
  btc: { balanceSats: number; display: string; usd: number };
  assets: AssetView[];
  groups: { chain: ChainId; assets: AssetView[] }[];
  totalUsd: number;
  totalCny: number;
  rateCny: number;
  busy: boolean;
  refresh: () => Promise<void>;
  customTokens: CustomToken[];
  reloadCustom: () => Promise<void>;
};

function usdForAsset(asset: AssetDef, displayBalance: number, prices: Record<string, number>): number {
  if (asset.symbol === "USDC" || asset.symbol === "USDT") return displayBalance;
  if (asset.chainId === "bsc") return displayBalance * (prices["BNB"] ?? 0);
  if (asset.chainId === "polygon") return displayBalance * (prices["POL"] ?? 0);
  return 0;
}

export function useAssets(evmAddress: string | undefined) {
  const { chain, price: btcCny, busy: btcBusy, refresh: refreshBtc } = useBlockchain();
  const [custom, setCustom] = useState<CustomToken[]>([]);
  const [assets, setAssets] = useState<AssetView[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const reloadCustom = useCallback(async () => {
    setCustom(await loadCustomTokens());
  }, []);

  useEffect(() => {
    void reloadCustom();
  }, [reloadCustom]);

  const refresh = useCallback(async () => {
    // U-3 修复：evmAddress 空时早退——避免 RPC 拿到空地址返回"0x000..."假余额。
    if (!evmAddress) {
      setAssets([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      await refreshBtc();
      const priceMap = await fetchUsdPrices(["bitcoin", "binancecoin", "matic-network"]);
      setPrices(priceMap);

      const all = allAssets(custom);
      const evmAssets = all.filter((a) => a.kind !== "btc");
      const results = await Promise.allSettled(
        evmAssets.map(async (asset): Promise<AssetView> => {
          let rawBalance = 0n;
          let displayBalance = "0";
          if (asset.kind === "native" && asset.chainId) {
            rawBalance = await fetchNativeBalance(asset.chainId, evmAddress);
            displayBalance = formatEvm(rawBalance, asset.decimals ?? 18);
          } else if (asset.kind === "erc20" && asset.chainId) {
            const bal = await fetchErc20BalanceFor(asset, evmAddress);
            rawBalance = bal.rawBalance;
            displayBalance = bal.displayBalance;
          }
          const usd = usdForAsset(asset, Number(displayBalance) || 0, priceMap);
          return { asset, rawBalance, displayBalance, usd };
        }),
      );
      const views: AssetView[] = results
        .map((r) => (r.status === "fulfilled" ? r.value : null))
        .filter((v): v is AssetView => Boolean(v));
      setAssets(views);
    } catch (error) {
      logger.warn("Failed to load assets", error);
    } finally {
      setBusy(false);
    }
  }, [custom, evmAddress, refreshBtc]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const balanceSats = chain?.balanceSats ?? 0;
  const btcDisplay = satsToBtc(balanceSats);
  // Prefer the same CoinGecko USD source used for tokens (single currency,
  // single source => no flicker between CNY-approx and USD on refresh). Fall
  // back to the Coinbase CNY price / 7.2 only when CoinGecko is unavailable.
  const btcRateUsd = prices["BTC"] ?? (btcCny ? btcCny / 7.2 : 0);
  const btcUsd = (balanceSats / SATS_PER_BTC) * btcRateUsd;
  const assetUsd = assets.reduce((sum, a) => sum + a.usd, 0);
  const totalUsd = (Number.isFinite(btcUsd) ? btcUsd : 0) + assetUsd;
  // USD -> CNY rate derived from the BTC price quoted in both currencies
  // (single source => no flicker). Fall back to a static 1/7.2 if CoinGecko
  // is unavailable.
  const rateCny = prices["BTC"] && btcCny ? btcCny / prices["BTC"] : 1 / 7.2;
  const totalCny = totalUsd * rateCny;

  const grouped = chainGroups(allAssets(custom))
    .map((g) => ({
      chain: g.chain,
      assets: g.assets
        .map((a) => assets.find((v) => v.asset.id === a.id))
        .filter((v): v is AssetView => Boolean(v)),
    }))
    .filter((g) => g.assets.length > 0);

  return {
    btc: { balanceSats, display: btcDisplay, usd: Number.isFinite(btcUsd) ? btcUsd : 0 },
    assets,
    groups: grouped,
    totalUsd,
    totalCny: Number.isFinite(totalCny) ? totalCny : 0,
    rateCny,
    busy: busy || btcBusy,
    refresh,
    customTokens: custom,
    reloadCustom,
  };
}

function formatEvm(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = raw % base;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const trimmed = padded.length > 6 ? padded.slice(0, 6) : padded;
  return `${whole}.${trimmed}`;
}
