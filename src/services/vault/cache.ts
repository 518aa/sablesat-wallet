import type { VaultConfig } from "./types";

let cache: VaultConfig[] | null = null;

export function getVaultsCache(): VaultConfig[] | null {
  return cache;
}

export function setVaultsCache(next: VaultConfig[] | null): void {
  cache = next;
}

export function clearVaultsCache(): void {
  cache = null;
}
