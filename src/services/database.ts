import { onWalletDeleted } from "./lifecycle";

// Web / 测试环境的内存实现。签名必须与 database.native.ts 保持一致，
// 否则平台间行为分叉（旧版 loadTransactions 的 address 参数在 native 侧其实
// 被忽略、返回全表，web 侧却按地址过滤——同一段调用代码两个语义）。

const webTransactions = new Map<string, StoredTransaction[]>();

export type StoredTransaction = {
  txid: string;
  address: string;
  valueSats: number;
  confirmed: boolean;
  timestamp: number;
  blockHeight: number | null;
};

export async function saveTransactions(
  address: string,
  txs: Array<{ txid: string; confirmed: boolean; valueSats: number; time?: number }>
): Promise<void> {
  const now = Date.now();
  webTransactions.set(
    address,
    txs.map((tx) => ({
      txid: tx.txid,
      address,
      valueSats: tx.valueSats,
      confirmed: tx.confirmed,
      timestamp: tx.time ? tx.time * 1000 : now,
      blockHeight: null,
    })),
  );
}

/** 与 native 侧一致：返回全部钱包交易，按时间倒序。 */
export async function loadTransactions(limit = 50): Promise<StoredTransaction[]> {
  const all: StoredTransaction[] = [];
  for (const list of webTransactions.values()) all.push(...list);
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function clearTransactions(): Promise<void> {
  webTransactions.clear();
}

// 与 native 侧一致：注册到钱包生命周期，deleteWallet() 时自动清理。
onWalletDeleted(clearTransactions);
