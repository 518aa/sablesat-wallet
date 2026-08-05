import { base64 } from "@scure/base";
import { logger } from "./../logger";
import { PSBT_QR_CHAR_LIMIT } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// BC-UR 动态 QR（ur:crypto-psbt 分片轮播）。
//
// 【为什么必须有】单 QR 上限 1200 字符对 2-of-3 P2WSH 远远不够：每个输入要带
// witnessScript(≈105B) + 3 组 bip32Derivation + witnessUtxo，base64 后单输入
// 就 400+ 字符，3 个以上输入必然超限。而离线签名终端是气隙设备，剪贴板不共享，
// QR 是唯一通道——超限后旧实现没有任何降级路径。
//
// BC-UR 是 Sparrow / Foundation Passport / Keystone / BlueWallet 的事实标准，
// 实现后既解决容量问题又白拿互操作性。
// ───────────────────────────────────────────────────────────────────────────

type UREncoder = {
  nextPart: () => string;
  readonly fragmentsLength: number;
};

type URDecoder = {
  receivePart: (part: string) => boolean;
  isComplete: () => boolean;
  isSuccess: () => boolean;
  resultUR: () => { type: string; decodeCBOR: () => Uint8Array };
  getProgress: () => number;
  resultError?: () => string;
};

type UrInstance = { readonly type: string; readonly cbor: Uint8Array };

type BcUrModule = {
  UR: {
    new (cborPayload: Uint8Array, type: string): UrInstance;
    fromBuffer: (buf: Uint8Array) => UrInstance;
  };
  UREncoder: new (ur: unknown, maxFragmentLength: number, firstSeqNum?: number) => UREncoder;
  URDecoder: new () => URDecoder;
};

let mod: BcUrModule | null = null;
let probed = false;

function getModule(): BcUrModule | null {
  if (probed) return mod;
  probed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("@ngraveio/bc-ur") as BcUrModule;
  } catch {
    logger.warn("@ngraveio/bc-ur unavailable; falling back to single-QR only");
  }
  return mod;
}

export function isUrAvailable(): boolean {
  return getModule() !== null;
}

/**
 * 单个分片的最大长度，单位是 **CBOR 载荷字节数,不是输出字符数**。
 *
 * 【实测校正】原值 300 是照着"字符数"设的,但 bc-ur 的 maxFragmentLength 量的是
 * 载荷字节;300 实际产出 655 字符的帧 —— QR 版本被推到很高、码点密集,手机摄像头
 * 在屏幕反光下很难稳定识别。实测对照(2400 字节 PSBT):
 *     80 → 31 片, 首帧 212 字符
 *    120 → 21 片, 首帧 284 字符
 *    150 → 17 片, 首帧 338 字符
 *    300 →  8 片, 首帧 655 字符
 * 取 120:单帧约 280 字符对应 QR 版本 ~12,识别稳,帧数也不至于太多。
 */
export const UR_FRAGMENT_MAX = 120;

export class UrUnavailableError extends Error {
  constructor() {
    super("BC-UR module unavailable and PSBT exceeds single-QR capacity");
  }
}

/**
 * 把字节数组编码成 CBOR 字节串（major type 2）。
 * RFC 8949 §3.1：0x40|len(<24) / 0x58+u8 / 0x59+u16 / 0x5a+u32。
 */
function cborByteString(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  let header: number[];
  if (n < 24) header = [0x40 | n];
  else if (n < 0x100) header = [0x58, n];
  else if (n < 0x10000) header = [0x59, (n >> 8) & 0xff, n & 0xff];
  else header = [0x5a, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const out = new Uint8Array(header.length + n);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

/** PSBT 魔数 "psbt\xff"。解码后校验，把静默损坏变成明确报错。 */
const PSBT_MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff];

/**
 * 把 decodeCBOR 的返回值收敛成 Uint8Array。
 * 库在不同环境下可能返回 Buffer / Uint8Array / 普通数组；返回对象说明编码侧
 * 出了问题（见 planPsbtQr 里 ② 的说明），必须抛错而不是给出一个空数组。
 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  throw new Error("UR payload is not a byte string — CBOR encoding mismatch");
}

export type PsbtQrPlan =
  | { mode: "single"; payload: string }
  | { mode: "animated"; frames: string[] };

/**
 * 为 PSBT 生成 QR 播放计划。
 * 小于单 QR 容量时直接用 base64；否则切成 ur:crypto-psbt 分片轮播。
 */
export function planPsbtQr(psbtB64: string): PsbtQrPlan {
  if (psbtB64.length <= PSBT_QR_CHAR_LIMIT) {
    return { mode: "single", payload: psbtB64 };
  }
  const m = getModule();
  if (!m) throw new UrUnavailableError();

  const bytes = base64.decode(psbtB64.trim());
  // 两件事都不能靠库的默认行为：
  //
  // ① **registry type 必须是 crypto-psbt。** UR.fromBuffer 打出来的是 "bytes"。
  //    Sparrow / Keystone / Passport / BlueWallet 按 registry type 分派，收到
  //    ur:bytes 只当成一段裸字节，认不出是 PSBT —— 互操作性正是接 BC-UR 的一半
  //    理由，白丢没有意义。
  //
  // ② **CBOR 自己编。** UR.fromBuffer 只认 Node Buffer；喂原生 Uint8Array
  //    （base64.decode 返回的正是这个）时，它的 CBOR 编码器会把字节数组当成
  //    普通对象逐元素序列化 —— 实测 2403 字节膨胀到 15454 字节、分片从 21 片
  //    涨到 129 片，而且解码端拿回来的是个 Object，Uint8Array.from 之后长度为 0。
  //    **静默损坏，没有任何报错**。RN 里没有全局 Buffer，指望 polyfill 更不可靠。
  //    CBOR 的字节串编码只有 4 行，自己写掉这个不确定性。
  const ur = new m.UR(cborByteString(bytes), "crypto-psbt");
  const encoder = new m.UREncoder(ur, UR_FRAGMENT_MAX);
  // 生成 fragmentsLength 的 2 倍帧数：BC-UR 的 fountain 编码允许接收端漏掉
  // 若干帧后仍能通过后续冗余帧补齐，播放循环时更稳。
  const frameCount = Math.max(encoder.fragmentsLength * 2, 4);
  const frames: string[] = [];
  for (let i = 0; i < frameCount; i++) frames.push(encoder.nextPart());
  return { mode: "animated", frames };
}

/** 扫描端增量解码器。 */
export class PsbtUrScanner {
  private decoder: URDecoder | null;

  constructor() {
    const m = getModule();
    this.decoder = m ? new m.URDecoder() : null;
  }

  /** 喂入一帧。返回完成的 PSBT base64，或 null 表示还需更多帧。 */
  receive(part: string): { done: false; progress: number } | { done: true; psbtB64: string } {
    const trimmed = part.trim();

    // 非 UR 格式：可能是完整的单 QR base64 PSBT
    if (!/^ur:/i.test(trimmed)) {
      if (/^cHNidP/.test(trimmed)) return { done: true, psbtB64: trimmed };
      return { done: false, progress: 0 };
    }

    if (!this.decoder) throw new UrUnavailableError();
    this.decoder.receivePart(trimmed);

    if (!this.decoder.isComplete()) {
      return { done: false, progress: this.decoder.getProgress() };
    }
    if (!this.decoder.isSuccess()) {
      const err = this.decoder.resultError?.() ?? "unknown";
      this.reset();
      throw new Error(`UR decode failed: ${err}`);
    }

    const ur = this.decoder.resultUR();
    if (ur.type !== "crypto-psbt" && ur.type !== "bytes") {
      this.reset();
      throw new Error(`Unexpected UR type: ${ur.type}`);
    }
    const payload = toBytes(ur.decodeCBOR());
    // 魔数校验：收齐了所有分片、CBOR 也解开了，但内容不是 PSBT —— 说明发送端
    // 编码有问题或扫到了别的 UR。这一步是最后一道能把**静默损坏**变成明确报错
    // 的关卡；缺了它，用户会拿到一个空的/乱的 PSBT 再去签名。
    if (payload.length < PSBT_MAGIC.length || PSBT_MAGIC.some((b, i) => payload[i] !== b)) {
      this.reset();
      throw new Error("Decoded UR payload is not a PSBT");
    }
    const psbtB64 = base64.encode(payload);
    this.reset();
    return { done: true, psbtB64 };
  }

  reset(): void {
    const m = getModule();
    this.decoder = m ? new m.URDecoder() : null;
  }
}
