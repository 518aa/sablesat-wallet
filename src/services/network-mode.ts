import AsyncStorage from "@react-native-async-storage/async-storage";
import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { logger } from "./logger";

export type NetworkMode = "mainnet" | "testnet";
type BtcNetwork = typeof NETWORK;

const STORAGE_KEY = "bitnest.network.mode";

const MAINNET_API_BASE = [
  "https://mempool.space/api",
  "https://blockstream.info/api",
];

const TESTNET_API_BASE = [
  "https://blockstream.info/testnet/api",
  "https://mempool.space/testnet/api",
];

let cachedMode: NetworkMode | null = null;
let initPromise: Promise<NetworkMode> | null = null;
const listeners = new Set<(mode: NetworkMode) => void>();

async function loadMode(): Promise<NetworkMode> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (raw === "mainnet" || raw === "testnet") {
    cachedMode = raw;
    return raw;
  }
  cachedMode = "mainnet";
  return cachedMode;
}

export function getNetworkModeSync(): NetworkMode {
  return cachedMode ?? "mainnet";
}

export async function getNetworkMode(): Promise<NetworkMode> {
  if (cachedMode) return cachedMode;
  if (!initPromise) initPromise = loadMode();
  return initPromise;
}

export async function setNetworkMode(mode: NetworkMode): Promise<void> {
  cachedMode = mode;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, mode);
  } catch (err) {
    logger.warn("Failed to persist network mode", err);
  }
  for (const listener of listeners) {
    try {
      listener(mode);
    } catch (err) {
      logger.warn("Network mode listener threw", err);
    }
  }
}

export function getBtcNetwork(): BtcNetwork {
  return getNetworkModeSync() === "testnet" ? TEST_NETWORK : NETWORK;
}

export function getApiBase(): string[] {
  return getNetworkModeSync() === "testnet" ? TESTNET_API_BASE : MAINNET_API_BASE;
}

export function subscribe(listener: (mode: NetworkMode) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
