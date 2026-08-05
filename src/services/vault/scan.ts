import AsyncStorage from "@react-native-async-storage/async-storage";
import { GAP_LIMIT } from "../wallet";
import { scanUtxosBatched } from "../transaction";
import { deriveVaultAddressList } from "./multisig";
import { logger } from "../logger";
import type { DerivedVaultAddress, VaultConfig, VaultUtxo } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// 金库地址扫描：**按已用索引生长的 gap limit**。
//
// 【旧实现是一堵固定的墙】useVault 里写死 RECEIVE_SCAN_COUNT = 20 /
// CHANGE_SCAN_COUNT = 20，只扫 0..19，且**不随使用生长**。
//
// 单签钱包不是这么做的 —— wallet.ts 是 `maxRecv + GAP_LIMIT`，按持久化的最高
// 已用索引往外扩。金库这边被漏掉了，后果是：任何落在 index 20 以上的资金，
// 这个 App **永远看不到**，余额少算、UTXO 少算、发送时报"余额不足"。
//
// 自己用不容易踩到（详情页只显示 receiveAddresses[0]），但金库按定义是多方、
// 多工具的：descriptor 导进 Sparrow 后，对方按自己的 gap limit 生成 receive/25
// 收款，这边立刻变瞎。而"在一个客户端里加前端约束"对 Sparrow 没有任何约束力，
// 所以必须在扫描这一侧解决。
//
// 算法与 BIP44 gap limit 一致：
//   1. 窗口 = max(持久化最高已用索引, 本次扫到的最高索引) + GAP_LIMIT
//   2. 扫完一轮后，若最高命中索引已经逼近窗口边缘，扩大窗口再扫一轮
//   3. 直到出现连续 GAP_LIMIT 个空地址，或触及硬上限
// ───────────────────────────────────────────────────────────────────────────

/** 单次扫描的绝对上限，防御畸形数据导致派生几万个多签地址（每个含 n 次派生）。 */
const HARD_CAP = 500;
/** 最多迭代轮数。每轮都会扩窗重扫，批量接口下一轮 2~3 个请求。 */
const MAX_ROUNDS = 4;

function maxIdxKey(vaultId: string): string {
  return `bitnest.vault.maxIdx.${vaultId}`;
}

export type VaultMaxIndices = { receive: number; change: number };

/** 读取持久化的最高已用索引。-1 表示从未用过。 */
export async function readVaultMaxIndices(vaultId: string): Promise<VaultMaxIndices> {
  const raw = await AsyncStorage.getItem(maxIdxKey(vaultId)).catch(() => null);
  if (!raw) return { receive: -1, change: -1 };
  try {
    const parsed = JSON.parse(raw) as Partial<VaultMaxIndices>;
    const norm = (v: unknown) =>
      typeof v === "number" && Number.isInteger(v) && v >= -1 && v <= HARD_CAP ? v : -1;
    return { receive: norm(parsed.receive), change: norm(parsed.change) };
  } catch {
    return { receive: -1, change: -1 };
  }
}

/** 提交已用索引。**只前进不后退** —— 与 wallet.ts 的 commitChangeAddress 同一约定。 */
export async function commitVaultIndex(
  vaultId: string,
  kind: "receive" | "change",
  idx: number,
): Promise<void> {
  if (!Number.isInteger(idx) || idx < 0 || idx > HARD_CAP) return;
  const cur = await readVaultMaxIndices(vaultId);
  if (idx <= cur[kind]) return;
  const next = { ...cur, [kind]: idx };
  await AsyncStorage.setItem(maxIdxKey(vaultId), JSON.stringify(next)).catch((err) => {
    logger.warn("Failed to persist vault index", err);
  });
}

export type VaultScanResult = {
  utxos: VaultUtxo[];
  receiveAddresses: DerivedVaultAddress[];
  changeAddresses: DerivedVaultAddress[];
  /** 本次扫描覆盖的最高索引（receive / change 同窗口）。 */
  window: number;
  /** 已用过的最高索引（持久化值与本次链上命中取大）。找零选址据此递增。 */
  maxUsed: VaultMaxIndices;
  /** 全部地址都查成功。false 时 utxos 是**下界**。 */
  complete: boolean;
  failed: number;
  total: number;
};

/**
 * 扫描金库全部地址的 UTXO，窗口按 gap limit 生长。
 *
 * 每轮扫完后，如果最高命中索引距离窗口边缘不足 GAP_LIMIT，说明窗口外可能还有
 * 资金，扩窗重扫。扫描失败（网络问题）时**不扩窗也不缩窗**，如实上报 complete。
 */
export async function scanVaultUtxos(vault: VaultConfig): Promise<VaultScanResult> {
  const persisted = await readVaultMaxIndices(vault.id);
  let window = Math.min(Math.max(persisted.receive, persisted.change, 0) + GAP_LIMIT, HARD_CAP);

  let last: VaultScanResult | null = null;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const count = window + 1;
    const receiveAddresses = deriveVaultAddressList(vault.cosigners, count, 0, vault.m);
    const changeAddresses = deriveVaultAddressList(vault.cosigners, 0, count, vault.m);
    const all = [...receiveAddresses, ...changeAddresses];
    const slotByAddress = new Map(all.map((a) => [a.address, a]));

    const result = await scanUtxosBatched(all.map((a) => a.address));
    const utxos: VaultUtxo[] = [];
    for (const u of result.data) {
      const slot = slotByAddress.get(u.address);
      if (!slot) continue;
      utxos.push({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        address: u.address,
        derivationIndex: slot.index,
        isChange: slot.isChange,
      });
    }

    // 命中的最高索引。没有任何 UTXO 时为 -1。
    let maxHitReceive = -1;
    let maxHitChange = -1;
    for (const u of utxos) {
      if (u.isChange) maxHitChange = Math.max(maxHitChange, u.derivationIndex);
      else maxHitReceive = Math.max(maxHitReceive, u.derivationIndex);
    }
    // 把链上事实写回持久化索引：下次冷启动直接从正确的窗口起扫。
    if (maxHitReceive >= 0) await commitVaultIndex(vault.id, "receive", maxHitReceive);
    if (maxHitChange >= 0) await commitVaultIndex(vault.id, "change", maxHitChange);

    last = {
      utxos,
      receiveAddresses,
      changeAddresses,
      window,
      maxUsed: {
        receive: Math.max(persisted.receive, maxHitReceive),
        change: Math.max(persisted.change, maxHitChange),
      },
      complete: result.complete,
      failed: result.failed,
      total: result.total,
    };

    // 数据不完整时不据此判断是否扩窗——那会把"网络失败"误读成"窗口够大"。
    if (!result.complete) break;

    const maxHit = Math.max(maxHitReceive, maxHitChange);
    // 连续 GAP_LIMIT 个空地址 → 窗口足够，停。
    if (maxHit + GAP_LIMIT <= window) break;
    if (window >= HARD_CAP) {
      logger.warn("Vault scan hit hard cap", { vaultId: vault.id, window, maxHit });
      break;
    }
    window = Math.min(maxHit + GAP_LIMIT, HARD_CAP);
  }

  return (
    last ?? {
      utxos: [],
      receiveAddresses: [],
      changeAddresses: [],
      window,
      maxUsed: persisted,
      complete: false,
      failed: 0,
      total: 0,
    }
  );
}
