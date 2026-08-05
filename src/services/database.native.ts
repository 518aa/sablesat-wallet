import * as SQLite from "expo-sqlite";
import { encrypt, decrypt, integrityTag } from "./crypto";
import { getWalletDataKey } from "./wallet";
import { logger } from "./logger";
import { onWalletDeleted } from "./lifecycle";

// ───────────────────────────────────────────────────────────────────────────
// 本地交易缓存。
//
// 【v3 改了什么】v2 只加密 address 一列，txid / valueSats / confirmed / timestamp
// 全是明文。**txid 明文等于没加密**：txid 在公链上完全可查，拿到 SQLite 文件的人
// 用任何一个区块浏览器就能还原全部地址、金额和交易对手。加密一列 address 只是
// 让审计清单上多一行"已加密"。
//
// v3 把整条记录（含 txid）加密成一个 GCM 密封块，只保留一个**不可逆**的行标识
// 用于去重：HMAC(walletDataKey, txid)。攻击者拿到文件看到的是一堆随机字节，
// 而钱包自己能算出同样的 HMAC 来做 upsert。
// ───────────────────────────────────────────────────────────────────────────
const DB_NAME = "bitnest.db";
const SCHEMA_VERSION = 3;

let db: SQLite.SQLiteDatabase | null = null;
let writeQueue: Promise<unknown> = Promise.resolve();

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`PRAGMA journal_mode = WAL;`);
    const versionRow = await db.getFirstAsync<{ user_version: number }>(`PRAGMA user_version;`);
    const currentVersion = versionRow?.user_version ?? 0;
    if (currentVersion < SCHEMA_VERSION) {
      // v1: 明文表 transactions
      // v2: transactions_v2，仅 address 加密（txid 明文 → 等于没加密）
      // v3: transactions_v3，整条记录加密，行标识用 HMAC(txid)
      // 缓存是可重建的（重新拉链上数据即可），直接丢弃旧表，不做数据迁移——
      // 迁移需要在升级时解密全表，而那时钱包未必已解锁。
      await db.execAsync(`DROP TABLE IF EXISTS transactions;`);
      await db.execAsync(`DROP TABLE IF EXISTS transactions_v2;`);
      await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS transactions_v3 (
        rowKey TEXT PRIMARY KEY,
        nonce BLOB NOT NULL,
        payload BLOB NOT NULL,
        sortKey INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tx_v3_sort ON transactions_v3(sortKey DESC);
    `);
  }
  return db;
}

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch((error) => {
    logger.error("[db] write queue error", error);
  });
  return next;
}

export type StoredTransaction = {
  txid: string;
  address: string;
  valueSats: number;
  confirmed: boolean;
  timestamp: number;
  blockHeight: number | null;
};

type TxRow = {
  rowKey: string;
  nonce: ArrayBuffer | Uint8Array;
  payload: ArrayBuffer | Uint8Array;
  sortKey: number;
};

function toBytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  if (blob instanceof Uint8Array) return blob;
  return new Uint8Array(blob);
}

/**
 * 行标识 = HMAC(walletDataKey, txid)。
 * 需要一个稳定的主键来做 upsert，但绝不能是明文 txid（明文 txid 在公链上一查
 * 就能还原整个钱包历史）。HMAC 对钱包是确定性的，对攻击者是不可逆的。
 */
async function rowKeyFor(txid: string): Promise<string> {
  const key = await getWalletDataKey();
  return integrityTag(key, `tx:${txid}`);
}

export async function saveTransactions(
  address: string,
  txs: Array<{ txid: string; confirmed: boolean; valueSats: number; time?: number }>
): Promise<void> {
  if (txs.length === 0) return;
  await withWriteLock(async () => {
    const database = await getDb();
    const now = Date.now();
    // 密钥取一次。旧实现在循环里对**同一个 address** 反复调 encryptAddress，
    // 每次都要 getWalletDataKey + 生成 nonce + 跑一次 GCM。32 个地址 × 20 笔
    // = 640 次，每次余额刷新都白跑一遍。
    const key = await getWalletDataKey();
    const rows = await Promise.all(
      txs.map(async (tx) => {
        const record: StoredTransaction = {
          txid: tx.txid,
          address,
          valueSats: tx.valueSats,
          confirmed: tx.confirmed,
          timestamp: tx.time ? tx.time * 1000 : now,
          blockHeight: null,
        };
        const { nonce, ciphertext } = encrypt(key, JSON.stringify(record));
        return {
          rowKey: await rowKeyFor(tx.txid),
          nonce,
          ciphertext,
          sortKey: record.timestamp,
        };
      }),
    );
    await database.withTransactionAsync(async () => {
      for (const r of rows) {
        await database.runAsync(
          `INSERT OR REPLACE INTO transactions_v3 (rowKey, nonce, payload, sortKey) VALUES (?, ?, ?, ?)`,
          [r.rowKey, r.nonce, r.ciphertext, r.sortKey],
        );
      }
    });
  });
}

export async function loadTransactions(limit = 50): Promise<StoredTransaction[]> {
  const database = await getDb();
  const rows = await database.getAllAsync<TxRow>(
    `SELECT rowKey, nonce, payload, sortKey FROM transactions_v3 ORDER BY sortKey DESC LIMIT ?`,
    [limit],
  );
  const key = await getWalletDataKey();
  const out: StoredTransaction[] = [];
  for (const row of rows) {
    // **逐行容错。**旧实现没有 try/catch：胁迫模式下 walletDataKey 来自诱饵种子，
    // 第一行就解不开并抛出，整个交易历史页直接崩 —— 而"表现得完全正常"恰恰是
    // 胁迫模式唯一的要求。跨钱包残留、部分写入同理。解不开的行跳过即可。
    try {
      const parsed = JSON.parse(decrypt(key, toBytes(row.nonce), toBytes(row.payload))) as StoredTransaction;
      if (typeof parsed?.txid === "string") out.push(parsed);
    } catch {
      /* 本钱包解不开的行：跳过，不影响其余 */
    }
  }
  return out;
}

/**
 * 清空本地交易缓存。deleteWallet / 切换钱包时必须调用 ——
 * 旧实现只清 SecureStore 与 AsyncStorage，SQLite 里上一个钱包的记录会一直留着。
 */
export async function clearTransactions(): Promise<void> {
  await withWriteLock(async () => {
    const database = await getDb();
    await database.execAsync(`DELETE FROM transactions_v3;`);
  });
}

// 自注册到钱包生命周期：deleteWallet() 会跑到这里，wallet.ts 不需要知道
// database 的存在（否则形成循环依赖）。
onWalletDeleted(clearTransactions);
