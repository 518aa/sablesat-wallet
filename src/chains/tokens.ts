import AsyncStorage from "@react-native-async-storage/async-storage";
import { STABLECOINS } from "./stablecoins";

export type ChainId = "bsc" | "polygon";
export type AssetKind = "btc" | "native" | "erc20";

export type EvmChainConfig = {
  id: ChainId;
  name: string;
  shortName: string;
  chainHexId: string;
  rpcUrls: string[];
  explorerTxUrl: string;
  nativeSymbol: string;
  nativeName: string;
  feeSymbol: string;
  coingeckoId: string;
};

export const EVM_CHAINS: Record<ChainId, EvmChainConfig> = {
  bsc: {
    id: "bsc",
    name: "BNB Smart Chain",
    shortName: "BSC",
    chainHexId: "0x38",
    rpcUrls: ["https://bsc-dataseed.binance.org", "https://bsc.publicnode.com"],
    explorerTxUrl: "https://bscscan.com/tx/",
    nativeSymbol: "BNB",
    nativeName: "BNB",
    feeSymbol: "BNB",
    coingeckoId: "binancecoin",
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    shortName: "Polygon",
    chainHexId: "0x89",
    rpcUrls: ["https://polygon-rpc.com", "https://polygon-bor.publicnode.com"],
    explorerTxUrl: "https://polygonscan.com/tx/",
    nativeSymbol: "POL",
    nativeName: "Polygon",
    feeSymbol: "POL",
    coingeckoId: "matic-network",
  },
};

export type AssetDef = {
  id: string;
  kind: AssetKind;
  symbol: string;
  name: string;
  chainId?: ChainId;
  contractAddress?: string;
  decimals?: number;
  feeSymbol?: string;
  custom?: boolean;
};

export const BTC_ASSET: AssetDef = { id: "btc", kind: "btc", symbol: "BTC", name: "Bitcoin" };

export const BNB_ASSET: AssetDef = {
  id: "bnb",
  kind: "native",
  symbol: "BNB",
  name: "BNB",
  chainId: "bsc",
  decimals: 18,
  feeSymbol: "BNB",
};

export const POL_ASSET: AssetDef = {
  id: "pol",
  kind: "native",
  symbol: "POL",
  name: "Polygon",
  chainId: "polygon",
  decimals: 18,
  feeSymbol: "POL",
};

export const BUILTIN_ASSETS: AssetDef[] = [
  BTC_ASSET,
  BNB_ASSET,
  POL_ASSET,
  ...STABLECOINS.map(
    (t): AssetDef => ({
      id: t.id,
      kind: "erc20",
      symbol: t.symbol,
      name: t.name,
      chainId: t.chainId,
      contractAddress: t.contractAddress,
      decimals: t.decimals,
      feeSymbol: t.feeSymbol,
    }),
  ),
];

export type CustomToken = AssetDef & { custom: true };

// 折叠 UI：把非 BTC 资产按链分组（BNB Chain / Polygon）。
export function chainGroups(assets: AssetDef[]): { chain: ChainId; assets: AssetDef[] }[] {
  const groups: { chain: ChainId; assets: AssetDef[] }[] = [
    { chain: "bsc", assets: [] },
    { chain: "polygon", assets: [] },
  ];
  for (const a of assets) {
    if (a.kind !== "btc" && a.chainId) {
      groups.find((g) => g.chain === a.chainId)?.assets.push(a);
    }
  }
  return groups;
}

const CUSTOM_KEY = "bitnest.customTokens";

export async function loadCustomTokens(): Promise<CustomToken[]> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is CustomToken => !!t && typeof t.id === "string" && !!t.contractAddress && !!t.chainId,
    );
  } catch {
    return [];
  }
}

export async function saveCustomTokens(tokens: CustomToken[]): Promise<void> {
  await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(tokens));
}

export async function addCustomToken(token: CustomToken): Promise<CustomToken[]> {
  const existing = await loadCustomTokens();
  if (existing.some((t) => t.id === token.id)) return existing;
  const next = [...existing, token];
  await saveCustomTokens(next);
  return next;
}

export async function removeCustomToken(id: string): Promise<CustomToken[]> {
  const existing = await loadCustomTokens();
  const next = existing.filter((t) => t.id !== id);
  await saveCustomTokens(next);
  return next;
}

export function allAssets(custom: CustomToken[]): AssetDef[] {
  return [...BUILTIN_ASSETS, ...custom];
}

export function getAsset(id: string, custom: CustomToken[]): AssetDef | undefined {
  return allAssets(custom).find((a) => a.id === id);
}
