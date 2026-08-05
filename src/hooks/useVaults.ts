import { useCallback, useEffect, useState } from "react";
import { secureRandomBytes } from "../services/randomness";
import { listVaults, saveVault, deleteVault } from "../services/vault/config";
import {
  assertNoDuplicateCosigners,
  buildVaultDescriptor,
  parseVaultDescriptor,
  parseKeyExpression,
  DuplicateCosignerError,
  type DescriptorForm,
} from "../services/vault/descriptor";
import { parseBip32Path } from "../services/wallet";
import { deriveSelfCosigner } from "../services/vault/cosigner";
import { isWalletUnlocked, getRootUnlocked } from "../services/wallet";
import { normalizedKeyId } from "../services/vault/descriptor";
import type { Cosigner, VaultConfig } from "../services/vault/types";

export type UseVaultsResult = {
  vaults: VaultConfig[];
  selfCosigner: Cosigner | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createVault: (params: {
    name: string;
    cosignerInputs: CosignerInput[];
    m: number;
    /** BIP48 account 索引。默认 0；只有明确要做密钥隔离时才改。 */
    accountIndex?: number;
  }) => Promise<{ vault: VaultConfig; descriptor: DescriptorForm }>;
  /** 从 output descriptor 恢复金库。这是删除/换机后的**唯一**可靠恢复路径。 */
  importVaultFromDescriptor: (
    descriptor: string,
    name?: string,
  ) => Promise<{ vault: VaultConfig; selfMatched: boolean }>;
  removeVault: (id: string) => Promise<void>;
  /** 用户确认已备份 descriptor 后调用；未确认前不允许显示收款地址。 */
  markDescriptorBackedUp: (id: string) => Promise<void>;
  /** 按指定 account 索引派生本机 cosigner（建库/恢复时核对用）。 */
  selfCosignerAt: (accountIndex: number) => Cosigner | null;
};

export class VaultAlreadyExistsError extends Error {
  constructor(public readonly existingId: string) {
    super("A vault with the same cosigner set already exists");
  }
}

export class SelfNotInDescriptorError extends Error {
  constructor() {
    super("This device's key is not among the descriptor's cosigners");
  }
}

/**
 * 协签方输入缺少 key origin（master fingerprint + 派生路径）。
 *
 * master fingerprint 无法从 account 级 xpub 推导，路径也无从得知。旧实现在这里
 * 编了一个（account 节点自身的指纹 + 抄本机的路径），导致导出的 descriptor 与
 * PSBT 的 key origin 全错，对端设备认不出自己的输入。宁可拒绝建库。
 */
export class MissingKeyOriginError extends Error {
  constructor(public readonly cosignerName: string) {
    super(
      `Cosigner "${cosignerName}" was given as a bare xpub. A full key expression is required, ` +
        `e.g. [f0e1d2c3/48h/0h/0h/2h]xpub6... — export it from the cosigner's device/wallet.`,
    );
  }
}

export type CosignerInput = { name: string; xpub: string };

/** vault 标识符。非密钥材料，但统一走加固熵源，避免再出现 expo-crypto 直调。 */
function randomId(): string {
  return Array.from(secureRandomBytes(16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 金库身份 = 排序后的 cosigner 公钥集合 + 阈值。与名字、创建时间无关。
 * 用 normalizedKeyId（pubkey + chaincode）而非 xpub 字符串：同一把密钥的
 * xpub / zpub / Zpub 序列化不同但等价，比字符串会漏判重复金库。
 */
function vaultFingerprint(cosigners: Pick<Cosigner, "xpub">[], m: number): string {
  const ids = cosigners.map((c) => {
    try {
      return normalizedKeyId(c.xpub);
    } catch {
      return c.xpub;
    }
  });
  return `${m}:${ids.sort().join(",")}`;
}

export function useVaults(): UseVaultsResult {
  const [vaults, setVaults] = useState<VaultConfig[]>([]);
  const [selfCosigner, setSelfCosigner] = useState<Cosigner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listVaults();
      setVaults(list);
      // ⚠️ 曾经这里用「现有金库最大 index + 1」派生 self cosigner。那是错的：
      // accountIndex 取自**可变的**金库列表，删除会改变它，导致重建同一个金库时
      // 派生出不同的 xpub —— 地址对不上，钱取不回。
      //
      // 现在固定用 account 0。需要密钥隔离的用户可在建库时显式指定索引，
      // 该索引会写进 descriptor 的派生路径（[fingerprint/48h/0h/{account}h/2h]），
      // 恢复时从 descriptor 读回，全程确定性。
      if (isWalletUnlocked()) setSelfCosigner(deriveSelfCosigner(getRootUnlocked(), 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vaults");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createVault = useCallback(
    async ({
      name,
      cosignerInputs,
      m,
      accountIndex = 0,
    }: { name: string; cosignerInputs: CosignerInput[]; m: number; accountIndex?: number }) => {
      if (!isWalletUnlocked()) throw new Error("Wallet locked");
      // 按指定 account 索引重新派生本机 cosigner（默认 0）
      const selfCosigner = deriveSelfCosigner(getRootUnlocked(), accountIndex);
      // 协签方输入解析。
      //
      // 【旧实现的两个错误，合起来让导出的描述符完全不可用】
      //   1. fingerprint 取自 `parseExtKey(xpub).fingerprint` —— 那是 account
      //      节点自身的指纹，不是 master fingerprint（后者从 account 级 xpub
      //      推不出来）。
      //   2. derivationPath 直接抄本机的 `selfCosigner.derivationPath` ——
      //      协签方若用了别的 account 索引，写进描述符和 PSBT 的 origin 就是编的。
      //
      // 结果：导出的 descriptor 里 key origin 全错，Sparrow / Bitcoin Core 匹配
      // 不到对端硬件设备，PSBT 里对端也认不出自己的输入。协签与恢复都会失败，
      // 而这两件事恰好是多签存在的全部意义。
      //
      // 现在要求协签方粘贴设备导出的**完整 key expression**
      // （`[f0e1d2c3/48h/0h/0h/2h]xpub6...`，Coldcard / Sparrow / Keystone /
      // Passport 的标准格式）。裸 xpub 缺 origin，无法安全建库，直接拒绝。
      const externalCosigners: Cosigner[] = cosignerInputs.map((input, idx) => {
        const name = input.name || `Cosigner ${idx + 2}`;
        const parsed = parseKeyExpression(input.xpub);
        if (!parsed.fingerprint || !parsed.derivationPath) {
          throw new MissingKeyOriginError(name);
        }
        return {
          role: "external",
          name,
          xpub: parsed.xpub,
          derivationPath: parsed.derivationPath,
          fingerprint: parsed.fingerprint,
        };
      });
      const allCosigners: Cosigner[] = [selfCosigner, ...externalCosigners];
      const n = allCosigners.length;
      if (m < 1 || m > n || !Number.isInteger(m)) {
        throw new Error(`Invalid threshold: m must be between 1 and ${n}, got ${m}`);
      }

      // 重复协签方检查。旧实现完全没有——把同一个 xpub 粘进 2-of-3 的两个外部
      // 槽位，vault 里就有两把相同密钥，实际退化成 1-of-2，而 sortedMultisig
      // 会正常接受、地址能生成、链上有效，用户完全无感。
      assertNoDuplicateCosigners(allCosigners);

      // accountIndex 必须是确定性的。默认 0；显式指定时会写进 descriptor 的
      // 派生路径，恢复时可原样读回。绝不再从金库列表推算。
      if (!Number.isInteger(accountIndex) || accountIndex < 0) {
        throw new Error(`Invalid account index: ${accountIndex}`);
      }

      // 相同 cosigner 组合 + 相同 m 就是同一个金库，重复创建没有意义，
      // 而且会让用户误以为建了个新的、往里打钱。
      const fp = vaultFingerprint(allCosigners, m);
      const dup = vaults.find((v) => vaultFingerprint(v.cosigners, v.m) === fp);
      if (dup) throw new VaultAlreadyExistsError(dup.id);

      const vault: VaultConfig = {
        id: randomId(),
        name: name.trim() || "Vault",
        m,
        n,
        scriptType: "p2wsh",
        cosigners: allCosigners,
        createdAt: Date.now(),
        accountIndex,
        descriptorBackedUp: false,
        schemaVersion: 2,
      };
      await saveVault(vault);
      setVaults((prev) => [...prev, vault]);
      // descriptor 必须在创建流程里立刻交给用户备份：设备丢失后仅有助记词
      // **无法**恢复多签资产。
      return { vault, descriptor: buildVaultDescriptor(vault) };
    },
    [vaults],
  );

  const removeVault = useCallback(async (id: string) => {
    await deleteVault(id);
    setVaults((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const selfCosignerAt = useCallback((accountIndex: number): Cosigner | null => {
    if (!isWalletUnlocked()) return null;
    try {
      return deriveSelfCosigner(getRootUnlocked(), accountIndex);
    } catch {
      return null;
    }
  }, []);

  /**
   * 从 output descriptor 恢复金库。
   *
   * 这是删除金库、换机、重装后的**唯一**可靠恢复路径 —— 「在两台设备上重新建一遍」
   * 并不等价：只要任一方的 account 索引或 cosigner 顺序不同，派生出的就是另一个金库。
   * descriptor 里带着每个 cosigner 的 fingerprint 与完整派生路径，是自包含的。
   */
  const importVaultFromDescriptor = useCallback(
    async (descriptor: string, name?: string) => {
      if (!isWalletUnlocked()) throw new Error("Wallet locked");
      const parsed = parseVaultDescriptor(descriptor); // 含 checksum 校验

      // 确认本机确实是其中一方，否则导进来也签不了名
      const root = getRootUnlocked();
      let selfMatched = false;
      const cosigners: Cosigner[] = parsed.cosigners.map((c, i) => {
        // 从 descriptor 的派生路径里读回 account 索引：m/48'/{coin}'/{account}'/2'
        let accountIndex = 0;
        try {
          const parts = parseBip32Path(c.derivationPath);
          if (parts.length >= 3) accountIndex = parts[2] & 0x7fffffff;
        } catch { /* 路径异常时保守用 0 */ }
        const mine = deriveSelfCosigner(root, accountIndex);
        // 按密钥材料比对，不比字符串。同一把密钥的 xpub / zpub / Zpub 序列化
        // 不同但等价——Sparrow 导出的描述符常带 zpub，旧的 `mine.xpub === c.xpub`
        // 会判定"本机不在这个金库里"并拒绝导入，把唯一的恢复路径堵死。
        let isSelf = false;
        try {
          isSelf = normalizedKeyId(mine.xpub) === normalizedKeyId(c.xpub);
        } catch {
          isSelf = false;
        }
        if (isSelf) selfMatched = true;
        return {
          role: isSelf ? "self" : "external",
          name: isSelf ? "This device" : `Cosigner ${i + 1}`,
          xpub: c.xpub,
          derivationPath: c.derivationPath,
          fingerprint: c.fingerprint,
        };
      });

      if (!selfMatched) throw new SelfNotInDescriptorError();
      assertNoDuplicateCosigners(cosigners);

      const fp = vaultFingerprint(cosigners, parsed.m);
      const existing = vaults.find((v) => vaultFingerprint(v.cosigners, v.m) === fp);
      if (existing) throw new VaultAlreadyExistsError(existing.id);

      const selfEntry = cosigners.find((c) => c.role === "self");
      let accountIndex = 0;
      try {
        const parts = parseBip32Path(selfEntry!.derivationPath);
        if (parts.length >= 3) accountIndex = parts[2] & 0x7fffffff;
      } catch { /* 同上 */ }

      const vault: VaultConfig = {
        id: randomId(),
        name: (name ?? "").trim() || "Recovered Vault",
        m: parsed.m,
        n: cosigners.length,
        scriptType: "p2wsh",
        cosigners,
        createdAt: Date.now(),
        accountIndex,
        descriptorBackedUp: true, // 是从 descriptor 恢复的，按定义已备份
        schemaVersion: 2,
      };
      await saveVault(vault);
      setVaults((prev) => [...prev, vault]);
      return { vault, selfMatched };
    },
    [vaults],
  );

  const markDescriptorBackedUp = useCallback(async (id: string) => {
    const target = vaults.find((v) => v.id === id);
    if (!target) return;
    const updated = { ...target, descriptorBackedUp: true };
    await saveVault(updated);
    setVaults((prev) => prev.map((v) => (v.id === id ? updated : v)));
  }, [vaults]);

  return {
    vaults,
    selfCosigner,
    loading,
    error,
    refresh,
    createVault,
    importVaultFromDescriptor,
    removeVault,
    markDescriptorBackedUp,
    selfCosignerAt,
  };
}

export { DuplicateCosignerError };
