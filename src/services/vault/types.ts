export type CosignerRole = "self" | "external";
export type VaultScriptType = "p2wsh";

export type Cosigner = {
  role: CosignerRole;
  name: string;
  xpub: string;
  derivationPath: string;
  fingerprint: string;
};

export type VaultConfig = {
  id: string;
  name: string;
  m: number;
  n: number;
  scriptType: VaultScriptType;
  cosigners: Cosigner[];
  createdAt: number;
  /**
   * BIP48 account 索引。
   * 旧实现把路径写死为 m/48'/{coin}'/0'/2'，同一个种子创建的**所有** vault 都
   * 共用同一把 cosigner 密钥——想建两个密钥相互独立的金库（如"日常"与"长期
   * 储蓄"）做不到，一个 vault 的 cosigner 泄露会同时影响另一个。
   */
  accountIndex: number;
  /** 用户是否已确认备份 output descriptor。未确认前不允许显示收款地址。 */
  descriptorBackedUp: boolean;
  schemaVersion: 2;
};

export type DerivedVaultAddress = {
  index: number;
  isChange: boolean;
  address: string;
};

export type VaultUtxo = {
  txid: string;
  vout: number;
  value: number;
  address: string;
  derivationIndex: number;
  isChange: boolean;
};

export type PsbtSummary = {
  inputs: Array<{ txid: string; vout: number; value: number; address: string }>;
  outputs: Array<{ address: string; sats: number; isChange: boolean }>;
  feeSats: number;
  signaturesPerInput: number[];
  readyToFinalize: boolean;
};

export const VAULT_M = 2;
export const VAULT_N = 3;

// BIP48 派生路径：m/48'/{coin}'/{account}'/2'  （2' = P2WSH）
export function getSelfDerivationPath(
  networkMode: "mainnet" | "testnet" = "mainnet",
  accountIndex = 0,
): string {
  const coinType = networkMode === "testnet" ? 1 : 0;
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error(`Invalid account index: ${accountIndex}`);
  }
  return `m/48'/${coinType}'/${accountIndex}'/2'`;
}

/**
 * 单个 QR 的容量上限。
 *
 * 2-of-3 的 P2WSH PSBT，每个输入要带 witnessScript(≈105B) + 3 组
 * bip32Derivation(≈3×57B) + witnessUtxo，base64 后单输入就 400+ 字符，
 * 3 个以上输入必然超限。超限时走 BC-UR 动态分片（见 vault/ur.ts）。
 */
export const PSBT_QR_CHAR_LIMIT = 1200;

export function psbtFitsQr(psbtB64: string): boolean {
  return psbtB64.length <= PSBT_QR_CHAR_LIMIT;
}
