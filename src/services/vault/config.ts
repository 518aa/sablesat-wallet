import AsyncStorage from "@react-native-async-storage/async-storage";
import { getWalletDataKey } from "../wallet";
import { getVaultsCache, setVaultsCache } from "./cache";
import { encodeVaultBlob, decodeVaultBlob } from "./encoding";
import type { VaultConfig } from "./types";
import { assertDescriptorSafe } from "./descriptor";
import { logger } from "../logger";

const VAULT_CONFIG_KEY = "bitnest.vault.configs.v1";

export { encodeVaultBlob, decodeVaultBlob };

export async function listVaults(): Promise<VaultConfig[]> {
  const cached = getVaultsCache();
  if (cached) return cached;
  const raw = await AsyncStorage.getItem(VAULT_CONFIG_KEY).catch(() => null);
  if (!raw) {
    setVaultsCache([]);
    return [];
  }
  try {
    const key = await getWalletDataKey();
    const decoded = decodeVaultBlob(raw, key);
    // schema 校验：旧实现是裸的 JSON.parse(...) as VaultConfig[]，没有任何检查。
    // blob 有 GCM 认证（外人改不了），但跨版本升级、部分写入、字段缺失都会让
    // 非法配置进入签名路径——比如 m=0 会生成任何人都能花的 script。
    const list = decoded.filter((v) => {
      try {
        assertValidVaultConfig(v);
        return true;
      } catch (err) {
        logger.warn("Dropping invalid vault config", { id: (v as VaultConfig)?.id, err });
        return false;
      }
    });
    setVaultsCache(list);
    return list;
  } catch (error) {
    logger.warn("Failed to decrypt vault configs", error);
    setVaultsCache([]);
    return [];
  }
}

/** vault 配置结构与安全约束校验。保存前与读取后都要过一遍。 */
export function assertValidVaultConfig(vault: VaultConfig): void {
  if (!vault || typeof vault !== "object") throw new Error("Vault config is not an object");
  if (vault.schemaVersion !== 2) throw new Error(`Unsupported schemaVersion ${vault.schemaVersion}`);
  if (typeof vault.id !== "string" || !vault.id) throw new Error("Vault id missing");
  if (typeof vault.name !== "string") throw new Error("Vault name missing");
  if (!Number.isInteger(vault.accountIndex) || vault.accountIndex < 0) {
    throw new Error("Vault accountIndex invalid");
  }
  if (!Array.isArray(vault.cosigners)) throw new Error("Vault cosigners missing");
  // m/n 边界、重复 xpub、脚本类型、密钥数量上限
  assertDescriptorSafe(vault);
}

export async function saveVault(vault: VaultConfig): Promise<void> {
  assertValidVaultConfig(vault);
  const list = await listVaults();
  const idx = list.findIndex((v) => v.id === vault.id);
  if (idx >= 0) list[idx] = vault;
  else list.push(vault);
  await persist(list);
}

export async function deleteVault(id: string): Promise<void> {
  const list = await listVaults();
  const next = list.filter((v) => v.id !== id);
  await persist(next);
}

export async function getVault(id: string): Promise<VaultConfig | null> {
  const list = await listVaults();
  return list.find((v) => v.id === id) ?? null;
}

async function persist(list: VaultConfig[]): Promise<void> {
  const key = await getWalletDataKey();
  const raw = encodeVaultBlob(list, key);
  await AsyncStorage.setItem(VAULT_CONFIG_KEY, raw);
  setVaultsCache(list);
}
