import { useCallback, useEffect, useState } from "react";
import { type UTXO } from "../services/transaction";
import { fetchWalletStateBlockchainInfo } from "../services/blockchainInfo";
import { scanVaultUtxos } from "../services/vault/scan";
import { getVault } from "../services/vault/config";
import type { DerivedVaultAddress, VaultConfig, VaultUtxo } from "../services/vault/types";
import { logger } from "../services/logger";

export type VaultBalanceState = {
  vault: VaultConfig | null;
  receiveAddresses: DerivedVaultAddress[];
  changeAddresses: DerivedVaultAddress[];
  utxos: VaultUtxo[];
  totalSats: number;
  /** 本次扫描覆盖的最高派生索引。随使用生长，不再是写死的 20。 */
  windowSize: number;
  /** 已用过的最高找零索引。-1 表示从未用过。新找零应取它 +1，避免地址复用。 */
  maxChangeIndex: number;
  /**
   * 本次扫描是否覆盖了全部地址。false 表示 totalSats 是**下界**——
   * UI 应提示"数据不完整，请下拉刷新"，而不是把它当作真实余额展示。
   */
  complete: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useVault(vaultId: string | null): VaultBalanceState {
  const [vault, setVault] = useState<VaultConfig | null>(null);
  const [receiveAddresses, setReceiveAddresses] = useState<DerivedVaultAddress[]>([]);
  const [changeAddresses, setChangeAddresses] = useState<DerivedVaultAddress[]>([]);
  const [utxos, setUtxos] = useState<VaultUtxo[]>([]);
  const [totalSats, setTotalSats] = useState(0);
  const [windowSize, setWindowSize] = useState(0);
  const [maxChangeIndex, setMaxChangeIndex] = useState(-1);
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!vaultId) return;
    setLoading(true);
    setError(null);
    try {
      const config = await getVault(vaultId);
      if (!config) {
        setVault(null);
        setError("Vault not found");
        return;
      }
      setVault(config);

      // 扫描窗口按 gap limit **生长**（实现见 services/vault/scan.ts）。
      // 旧实现写死 0..19 且不生长，任何落在 index 20 以上的资金这个 App 永远
      // 看不到 —— 而 descriptor 一旦导进 Sparrow，对方按自己的 gap limit
      // 生成更高索引的收款地址是完全正常的操作。
      const scan = await scanVaultUtxos(config);
      setReceiveAddresses(scan.receiveAddresses);
      setChangeAddresses(scan.changeAddresses);
      setWindowSize(scan.window);
      setMaxChangeIndex(scan.maxUsed.change);

      const addressList = [
        ...scan.receiveAddresses.map((a) => a.address),
        ...scan.changeAddresses.map((a) => a.address),
      ];

      // 【余额与 UTXO 扫描必须解耦】
      //
      // 旧实现（以及我上一版）把 totalSats 定义成"扫到的 UTXO 之和"。于是
      // /unspent 这一路只要出问题，余额就直接变成 0 —— 用户看到的是"钱没了"，
      // 而实际只是某个第三方 endpoint 不通。
      //
      // 余额和可花 UTXO 是两个独立问题，用两条独立的数据源回答：
      //   - 余额  ← /multiaddr（一次请求拿整组地址，实测稳定）
      //   - UTXO  ← /unspent（只有构造交易才需要）
      // /multiaddr 通了就显示真实余额，哪怕 UTXO 一条都没扫到。
      let chainBalance: number | null = null;
      try {
        chainBalance = (await fetchWalletStateBlockchainInfo(addressList)).balanceSats;
      } catch (err) {
        logger.warn("Vault balance via multiaddr failed", err);
      }

      // 【金库余额显示不稳定的根因】旧实现是「每个地址一次 HTTP」，40 个地址 =
      // 40 次请求打向同一个第三方 API。必然限流一部分；fanout 如实标记
      // complete=false，但这里为了「能显示」又容忍了部分失败 —— 于是**每次刷新
      // 失败的地址不同，合计余额就跟着上下跳**，用户看到的就是"忽多忽少"。
      //
      // 改走批量接口：40 个地址 = 2 次请求，限流概率接近零，余额稳定。
      // 同时保留完整性信息：只要有地址没查到，就明确告诉用户"数据不完整"，
      // 而不是把一个偏低的数字当真值展示。
      const flat = scan.utxos;
      const result = { complete: scan.complete, failed: scan.failed, total: scan.total };
      const utxoSum = flat.reduce((sum, u) => sum + u.value, 0);
      setUtxos(flat);
      // 余额优先用链上聚合值；multiaddr 不通时才退回 UTXO 之和。
      setTotalSats(chainBalance ?? utxoSum);
      // UTXO 集合是否可信：扫描全成功，且与链上余额对得上。
      // 对不上说明有地址没扫到（或超出扫描窗口）——发送路径必须知道这件事，
      // 否则会用一份缺斤少两的 UTXO 集合去构造交易，报出莫名其妙的"余额不足"。
      const trustworthy =
        result.complete && (chainBalance === null || chainBalance === utxoSum);
      setComplete(trustworthy);
      if (!trustworthy) {
        logger.warn("Vault UTXO scan not trustworthy", {
          failed: result.failed,
          total: result.total,
          chainBalance,
          utxoSum,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vault");
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    vault,
    receiveAddresses,
    changeAddresses,
    utxos,
    totalSats,
    windowSize,
    maxChangeIndex,
    complete,
    loading,
    error,
    refresh,
  };
}

export type { UTXO };
