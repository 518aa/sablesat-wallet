import * as SecureStore from "expo-secure-store";
import { logger } from "./logger";

// ───────────────────────────────────────────────────────────────────────────
// PIN 策略。**这里不再存 PIN 哈希，也不跑 KDF 做校验。**
//
// 原因：vault 用 AES-256-GCM 加密，PIN 错 → scrypt 派生的 KEK 错 → GCM 认证
// 标签校验失败 → 解密抛异常。解密本身就是密码学层面的强认证，比"哈希比对"
// 更严格。之前额外跑的 600k PBKDF2 在 PIN 正确时提供的安全价值为零，却占了
// 解锁总耗时的 92%（实测 1551ms / 1683ms）。
//
// 本模块只负责两件不需要 KDF 的事：
//   1. 失败计数与锁定退避（唯一真正需要状态的部分）
//   2. PIN 格式与强度校验
// ───────────────────────────────────────────────────────────────────────────

const COUNTER_KEY = "sablesat.pin.counter.v3";
const WIPE_POLICY_KEY = "sablesat.pin.wipe_policy.v1";

const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// 指数退避。旧实现是「5 次锁 60 秒 → 8 次直接抹除 vault」，5→8 之间没有任何
// 递增惩罚，而口袋误触 8 次就会永久销毁资产。改为逐级拉长，攻击者的在线尝试
// 速率被压到可忽略，误触用户只是多等一会儿。
const BACKOFF_MS: readonly number[] = [
  0, 0, 0, 0,            // 前 4 次不锁
  60_000,                // 5
  5 * 60_000,            // 6
  30 * 60_000,           // 7
  2 * 60 * 60_000,       // 8
  6 * 60 * 60_000,       // 9
  24 * 60 * 60_000,      // 10+
];

// 可选的「N 次失败后抹除 vault」策略。**默认关闭** —— 自毁对自托管钱包是
// 双刃剑，必须由用户在确认已备份助记词后显式开启。
const DEFAULT_WIPE_THRESHOLD = 20;

type Counter = { v: 3; failures: number; lastFailureAt: number };

const EMPTY: Counter = { v: 3, failures: 0, lastFailureAt: 0 };

async function readCounter(): Promise<Counter> {
  const raw = await SecureStore.getItemAsync(COUNTER_KEY, SECURE_OPTS).catch(() => null);
  if (!raw) return { ...EMPTY };
  try {
    const parsed = JSON.parse(raw) as Counter;
    if (parsed.v !== 3 || !Number.isInteger(parsed.failures) || parsed.failures < 0) {
      return { ...EMPTY };
    }
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

async function writeCounter(c: Counter): Promise<void> {
  await SecureStore.setItemAsync(COUNTER_KEY, JSON.stringify(c), SECURE_OPTS);
}

export type LockState = {
  locked: boolean;
  /** 解锁时刻（epoch ms）。locked 为 true 时有效。 */
  unlockAtMs?: number;
  failures: number;
  /** 距离触发抹除还剩几次（抹除策略关闭时为 undefined）。 */
  attemptsUntilWipe?: number;
};

function backoffFor(failures: number): number {
  if (failures <= 0) return 0;
  return BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
}

export async function getLockState(): Promise<LockState> {
  const c = await readCounter();
  const wipeAt = await getWipeThreshold();
  const backoff = backoffFor(c.failures);
  const unlockAt = c.lastFailureAt + backoff;
  return {
    locked: backoff > 0 && Date.now() < unlockAt,
    unlockAtMs: backoff > 0 ? unlockAt : undefined,
    failures: c.failures,
    attemptsUntilWipe: wipeAt === null ? undefined : Math.max(0, wipeAt - c.failures),
  };
}

/**
 * 一次尝试开始前调用。**写前递增**：进程被杀也不会漏计。
 * 旧实现是「比对失败后才递增并持久化」，攻击者在 KDF 返回后、写盘前杀掉进程
 * 就能规避计数。
 */
export async function beginAttempt(): Promise<LockState> {
  const state = await getLockState();
  if (state.locked) return state;
  const c = await readCounter();
  await writeCounter({ v: 3, failures: c.failures + 1, lastFailureAt: Date.now() });
  return state;
}

/** 尝试成功后调用：清零计数。 */
export async function resetFailures(): Promise<void> {
  const c = await readCounter();
  if (c.failures === 0) return;
  await writeCounter({ ...EMPTY });
}

/**
 * 尝试失败后调用。返回是否应触发 vault 抹除（仅在用户显式开启该策略时）。
 * 计数已在 beginAttempt 里递增，这里只判定策略。
 */
export async function recordFailure(): Promise<{ shouldWipe: boolean; state: LockState }> {
  const state = await getLockState();
  const threshold = await getWipeThreshold();
  const shouldWipe = threshold !== null && state.failures >= threshold;
  if (shouldWipe) {
    logger.warn("PIN failure threshold reached, wipe policy triggered", { failures: state.failures });
  }
  return { shouldWipe, state };
}

// ── 抹除策略（默认关闭，需用户显式开启）──

export async function getWipeThreshold(): Promise<number | null> {
  const raw = await SecureStore.getItemAsync(WIPE_POLICY_KEY, SECURE_OPTS).catch(() => null);
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function setWipeThreshold(threshold: number | null): Promise<void> {
  if (threshold === null) {
    await SecureStore.deleteItemAsync(WIPE_POLICY_KEY).catch(() => {});
    return;
  }
  if (!Number.isInteger(threshold) || threshold < 10) {
    throw new Error("Wipe threshold must be at least 10");
  }
  await SecureStore.setItemAsync(WIPE_POLICY_KEY, String(threshold), SECURE_OPTS);
}

export const SUGGESTED_WIPE_THRESHOLD = DEFAULT_WIPE_THRESHOLD;

export async function clearPinState(): Promise<void> {
  await SecureStore.deleteItemAsync(COUNTER_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(WIPE_POLICY_KEY).catch(() => {});
}

// ── 格式与强度校验 ──

export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 12;

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

const WEAK_PINS = new Set([
  "000000", "111111", "222222", "333333", "444444", "555555",
  "666666", "777777", "888888", "999999", "123456", "654321",
  "112233", "121212", "123123", "102030", "123321", "159753",
  "00000000", "11111111", "12345678", "87654321", "11223344",
  // 常见日期型
  "010101", "202020", "202426", "199999",
]);

/** 连续递增/递减序列，如 123456 / 987654 / 3456789。 */
function isSequential(pin: string): boolean {
  let inc = true;
  let dec = true;
  for (let i = 1; i < pin.length; i++) {
    const d = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (d !== 1) inc = false;
    if (d !== -1) dec = false;
  }
  return inc || dec;
}

/** 重复短模式，如 121212 / 123123 / 1111。 */
function isRepeatedPattern(pin: string): boolean {
  for (let len = 1; len <= pin.length / 2; len++) {
    if (pin.length % len !== 0) continue;
    const unit = pin.slice(0, len);
    if (pin === unit.repeat(pin.length / len)) return true;
  }
  return false;
}

/** 唯一数字过少（如 112211 只有 2 个不同数字）。 */
function hasTooFewDistinctDigits(pin: string): boolean {
  return new Set(pin).size <= 2;
}

export function isWeakPin(pin: string): boolean {
  if (WEAK_PINS.has(pin)) return true;
  if (isSequential(pin)) return true;
  if (isRepeatedPattern(pin)) return true;
  if (hasTooFewDistinctDigits(pin)) return true;
  return false;
}

export type PinStrengthIssue = "format" | "weak";

/**
 * 设置 PIN 前的统一校验。旧实现只有胁迫 PIN 走了 isWeakPin，主 PIN 完全没校验
 * ——用户可以把主 PIN 设成 123456。现在两条路径共用这一个入口。
 */
export function validateNewPin(pin: string): PinStrengthIssue | null {
  if (!isValidPinFormat(pin)) return "format";
  if (isWeakPin(pin)) return "weak";
  return null;
}

export function assertValidNewPin(pin: string): void {
  const issue = validateNewPin(pin);
  if (issue === "format") {
    throw new Error(`PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} digits`);
  }
  if (issue === "weak") throw new Error("PIN is too weak");
}
