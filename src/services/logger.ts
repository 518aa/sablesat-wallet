// 生产化日志：脱敏 console 替代。
//
// 与旧实现的差异：
//   1. 旧版 redact() 只处理 string 和 Error，logger.warn("x", {mnemonic}) 原样
//      透传给 logHook；现在**递归**处理对象/数组/Map/Set
//   2. 旧版脱敏规则覆盖地址/txid/pubkey/路径，**唯独漏了 BIP39 助记词**
//   3. 旧版最后一条 hex64 规则与 txid 规则完全相同，是死代码

const IS_DEV = __DEV__;

type RedactRule = readonly [pattern: RegExp, replacement: string];

// BIP39 英文词表里最常见的高频词，用于识别助记词序列。完整词表 2048 个词
// 太大不适合塞进正则；这里用「连续 8+ 个纯小写字母单词」这一结构特征来兜底，
// 对普通日志文本误伤可接受（日志本就不该打整句英文）。
const MNEMONIC_LIKE = /\b(?:[a-z]{3,8}\s+){7,23}[a-z]{3,8}\b/g;

const REDACT_RULES: readonly RedactRule[] = [
  // 助记词序列（8-24 个小写单词）—— 必须放最前，避免被其他规则切碎
  [MNEMONIC_LIKE, "[mnemonic]"],
  // 扩展公钥 / 私钥
  [/\b([xyztuv]pub|[xyztuv]prv)[1-9A-HJ-NP-Za-km-z]{100,115}\b/g, "[extkey]"],
  // Bitcoin 地址：bech32(m) / base58
  [
    /\b(bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,71}|tb1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{39,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g,
    "[addr]",
  ],
  // EVM 地址
  [/\b0x[a-fA-F0-9]{40}\b/g, "[evmaddr]"],
  // 公钥：66 或 130 hex（放在 txid 规则之前，长度更具体）
  [/\b(0[2-4][a-fA-F0-9]{64}|0[2-4][a-fA-F0-9]{128})\b/g, "[pubkey]"],
  // 64 hex：txid / seed / hash / 私钥
  [/\b[a-fA-F0-9]{64}\b/g, "[hex64]"],
  // BIP32 路径
  [/\bm\/(\d+['hH]?\/)*\d+['hH]?\b/g, "[path]"],
  // PSBT base64
  [/\bcHNidP[A-Za-z0-9+/=]{20,}/g, "[psbt]"],
];

// 键名命中即整体屏蔽，不看值长什么样。
const SENSITIVE_KEY = /mnemonic|seed|passphrase|privat|secret|pin|password|entropy|xprv|dek|kek/i;

const MAX_DEPTH = 6;

function redactString(value: string): string {
  let s = value;
  for (const [re, replacement] of REDACT_RULES) s = s.replace(re, replacement);
  return s;
}

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > MAX_DEPTH) return "[depth-limit]";

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value === "function") return "[function]";

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  // 任何原始字节都可能是密钥材料，一律不打印内容
  if (value instanceof Uint8Array || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[bytes:${(value as Uint8Array).byteLength ?? "?"}]`;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Set) return { __set: [...value].map((v) => redact(v, depth + 1)) };
  if (value instanceof Map) {
    return {
      __map: [...value.entries()].map(([k, v]) => [
        redact(k, depth + 1),
        SENSITIVE_KEY.test(String(k)) ? "[redacted]" : redact(v, depth + 1),
      ]),
    };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }

  return "[unknown]";
}

function redactArgs(args: unknown[]): unknown[] {
  return args.map((a) => redact(a));
}

type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, message: string, ...args: unknown[]): void {
  const safeMessage = redactString(message);
  const safe = redactArgs(args);

  if (IS_DEV) {
    const fn = console[level] as (...a: unknown[]) => void;
    fn(`[${level}] ${safeMessage}`, ...safe);
  }

  if (logHook) {
    try {
      logHook(level, safeMessage, safe);
    } catch {
      /* 钩子自身异常不干扰业务 */
    }
  }
}

type LogHook = (level: LogLevel, message: string, args: unknown[]) => void;
let logHook: LogHook | null = null;

export function setLogHook(hook: LogHook | null): void {
  logHook = hook;
}

export const logger = {
  debug(message: string, ...args: unknown[]) {
    if (IS_DEV) emit("debug", message, ...args);
  },
  info(message: string, ...args: unknown[]) {
    emit("info", message, ...args);
  },
  warn(message: string, ...args: unknown[]) {
    emit("warn", message, ...args);
  },
  error(message: string, ...args: unknown[]) {
    emit("error", message, ...args);
  },
  capture(exception: unknown, context?: string) {
    const err = exception instanceof Error ? exception : new Error(String(exception));
    const tag = context ? `[${context}] ` : "";
    emit("error", `${tag}${err.message}`, err);
    if (captureHook) {
      try {
        captureHook(err, context);
      } catch {
        /* 钩子自身异常不干扰业务 */
      }
    }
  },
};

type CaptureHook = (error: Error, context?: string) => void;
let captureHook: CaptureHook | null = null;

export function setCaptureHook(hook: CaptureHook | null): void {
  captureHook = hook;
}

/** 仅供测试使用。 */
export const __testing = { redact, redactString };
