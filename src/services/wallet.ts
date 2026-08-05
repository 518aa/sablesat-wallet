import AsyncStorage from "@react-native-async-storage/async-storage";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import {
  hasVault as vaultExists,
  createVault,
  openVaultWithPin,
  openVaultWithBiometrics,
  rewrapDekWithNewPin,
  clearVault,
  enableBiometricUnlock,
  disableBiometricUnlock,
  isBiometricUnlockEnabled,
  BiometricKeyUnavailableError,
  WrongPinError,
} from "./vaultKey";
import { clearVaultsCache } from "./vault/cache";
import { setupDuress, tryOpenDuress, clearDuress } from "./duress";
import { getBtcNetwork, getNetworkModeSync, type NetworkMode } from "./network-mode";
import { clearStablecoinCache, invalidateBlockchainCache } from "./cache";
import {
  assertValidNewPin,
  beginAttempt,
  recordFailure,
  resetFailures,
  getLockState,
  clearPinState,
  type LockState,
} from "./pin";
import { bytesToHex, doubleSha256 } from "./crypto";
import { secureRandomBytes } from "./randomness";
import { assertKdfParityOk } from "./kdf";
import { assertKeyGenerationAllowed, assertExportAllowed } from "./security";
import { runWalletDeletedHooks } from "./lifecycle";
import { logger } from "./logger";

// ── 派生路径 ──

function coinType(mode: NetworkMode = getNetworkModeSync()): number {
  return mode === "testnet" ? 1 : 0;
}

export function getAccountBasePath(): string {
  return `m/84'/${coinType()}'/0'`;
}
export function getReceiveBasePath(): string {
  return `${getAccountBasePath()}/0`;
}
export function getChangeBasePath(): string {
  return `${getAccountBasePath()}/1`;
}

const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0";
const WALLET_DATA_KEY_PATH = "m/123'/0'/0'/0'";

const RECEIVE_IDX_KEY = "sablesat.derivation.receive.idx";
const CHANGE_IDX_KEY = "sablesat.derivation.change.idx";

/**
 * BIP44 gap limit。**必须是 20。**
 *
 * 旧值是 5，而 README 声称扫描 `0..n+20`——文档与实现分叉，且 5 这个值在导入
 * 外部钱包助记词时会直接算错余额：只要地址树上有 6 个以上连续未使用的收款
 * 地址（换钱包、批量生成收款码、对方钱包 gap 更大，都会造成），后面的资金
 * 全部扫不到，UI 显示"余额不足"而链上明明有钱。
 *
 * 20 是 BIP44 规定值，也是 Electrum / Sparrow / BlueWallet 的默认值。互操作
 * 前提是大家用同一个值。
 */
export const GAP_LIMIT = 20;
export const HARDENED_OFFSET = 0x80000000;

export type Wallet = {
  address: string;
  publicKeyHex: string;
  path: string;
  evmAddress: string;
  evmPath: string;
};

/** vault 明文结构。口令词与助记词同处一个密封块 —— 见文件末尾「关于口令词」。 */
type VaultPlaintext = { v: 1; mnemonic: string; passphrase: string };

// ── 解锁态缓存 ──

let cachedRoot: HDKey | null = null;
let cachedDek: Uint8Array | null = null;
let cachedDataKey: Uint8Array | null = null;
// 预派生的 account 节点。旧实现每个地址都从 root 重走 5 层路径（每次 5 次
// HMAC-SHA512 + EC 运算）；缓存 account 后只需派生最后一级，实测 12 个地址
// 从 42ms 降到 8ms。
let cachedReceiveAccount: HDKey | null = null;
let cachedChangeAccount: HDKey | null = null;
// address → 派生信息。签名时按地址反查私钥，旧实现是 O(n) 线性重扫整棵树，
// 多输入交易会明显卡顿。
type AddrInfo = { child: HDKey; path: string; isChange: boolean; index: number };
let addressIndex: Map<string, AddrInfo> | null = null;
let addressIndexNetwork: NetworkMode | null = null;

let onLockCallbacks: Array<() => void> = [];
let lockGeneration = 0;
let isDuressMode = false;

const IDLE_LOCK_MS = 5 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function armIdleLock(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    lockWallet();
  }, IDLE_LOCK_MS);
}

function disarmIdleLock(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

export function onLock(cb: () => void): () => void {
  onLockCallbacks.push(cb);
  return () => {
    onLockCallbacks = onLockCallbacks.filter((c) => c !== cb);
  };
}

function asciiToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
  return bytes;
}

function getRoot(): HDKey {
  if (!cachedRoot) throw new Error("Wallet locked");
  armIdleLock();
  return cachedRoot;
}

// ── 派生缓存 ──

function primeCache(mnemonic: string, passphrase: string): HDKey {
  cachedRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase));
  refreshAccountCache();
  return cachedRoot;
}

function refreshAccountCache(): void {
  if (!cachedRoot) return;
  cachedReceiveAccount = cachedRoot.derive(getReceiveBasePath());
  cachedChangeAccount = cachedRoot.derive(getChangeBasePath());
  addressIndex = null;
  addressIndexNetwork = getNetworkModeSync();
}

/** 网络模式切换后必须重建缓存（coin type 变了，派生路径也变了）。 */
export function onNetworkModeChanged(): void {
  if (cachedRoot) refreshAccountCache();
}

function accountFor(isChange: boolean): HDKey {
  getRoot(); // 触发锁定检查 + 重置空闲计时
  if (addressIndexNetwork !== getNetworkModeSync()) refreshAccountCache();
  const node = isChange ? cachedChangeAccount : cachedReceiveAccount;
  if (!node) throw new Error("Wallet locked");
  return node;
}

function addressAt(isChange: boolean, index: number): string {
  const child = accountFor(isChange).deriveChild(index);
  if (!child.publicKey) throw new Error("Could not derive public key");
  const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
  if (!payment.address) throw new Error("Could not derive address");
  return payment.address;
}

function deriveReceiveAddressAt(idx: number): string {
  return addressAt(false, idx);
}
function deriveChangeAddressAt(idx: number): string {
  return addressAt(true, idx);
}

/** 建立/复用 address → 派生信息索引。覆盖 [0, used + GAP_LIMIT]。 */
async function getAddressIndex(): Promise<Map<string, AddrInfo>> {
  if (addressIndexNetwork !== getNetworkModeSync()) refreshAccountCache();
  const maxRecv = await readIndex(RECEIVE_IDX_KEY);
  const maxChange = await readIndex(CHANGE_IDX_KEY);
  const needed = (maxRecv + GAP_LIMIT + 1) * 2 + (maxChange - maxRecv);
  if (addressIndex && addressIndex.size >= needed) return addressIndex;

  const map = new Map<string, AddrInfo>();
  const build = (isChange: boolean, upper: number, base: string) => {
    const account = accountFor(isChange);
    for (let i = 0; i <= upper; i++) {
      const child = account.deriveChild(i);
      if (!child.publicKey) continue;
      const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
      if (!payment.address) continue;
      map.set(payment.address, { child, path: `${base}/${i}`, isChange, index: i });
    }
  };
  build(false, maxRecv + GAP_LIMIT, getReceiveBasePath());
  build(true, maxChange + GAP_LIMIT, getChangeBasePath());
  addressIndex = map;
  addressIndexNetwork = getNetworkModeSync();
  return map;
}

function checksumEvmAddress(addressHex: string): string {
  const lower = addressHex.toLowerCase();
  const hash = bytesToHex(keccak_256(asciiToBytes(lower)));
  let result = "0x";
  for (let i = 0; i < lower.length; i++) {
    result += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return result;
}

function deriveEvmWalletFromRoot(root: HDKey): { address: string } {
  const child = root.derive(EVM_DERIVATION_PATH);
  if (!child.privateKey) throw new Error("Could not derive EVM private key");
  const uncompressed = secp256k1.getPublicKey(child.privateKey, false).slice(1);
  return { address: checksumEvmAddress(bytesToHex(keccak_256(uncompressed).slice(-20))) };
}

function deriveFromRoot(root: HDKey): Wallet {
  const child = accountFor(false).deriveChild(0);
  if (!child.publicKey) throw new Error("Could not derive public key");
  const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
  if (!payment.address) throw new Error("Could not derive address");
  return {
    address: payment.address,
    publicKeyHex: bytesToHex(child.publicKey),
    path: `${getReceiveBasePath()}/0`,
    evmAddress: deriveEvmWalletFromRoot(root).address,
    evmPath: EVM_DERIVATION_PATH,
  };
}

// ── 派生索引持久化 ──

async function readIndex(key: string): Promise<number> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

const indexLocks = new Map<string, Promise<void>>();

async function bumpIndex(key: string): Promise<number> {
  while (indexLocks.has(key)) await indexLocks.get(key);
  let release!: () => void;
  indexLocks.set(key, new Promise<void>((r) => (release = r)));
  try {
    const current = await readIndex(key);
    await AsyncStorage.setItem(key, String(current + 1));
    addressIndex = null;
    return current;
  } finally {
    indexLocks.delete(key);
    release();
  }
}

export async function getCurrentReceiveAddress(): Promise<string> {
  return deriveReceiveAddressAt(await readIndex(RECEIVE_IDX_KEY));
}

export async function peekNextReceiveAddress(): Promise<string> {
  return deriveReceiveAddressAt((await readIndex(RECEIVE_IDX_KEY)) + 1);
}

export async function commitNextReceiveAddress(): Promise<string> {
  return deriveReceiveAddressAt(await bumpIndex(RECEIVE_IDX_KEY));
}

export async function getCurrentChangeAddress(): Promise<string> {
  return deriveChangeAddressAt(await readIndex(CHANGE_IDX_KEY));
}

export async function getCurrentReceiveIndex(): Promise<number> {
  return readIndex(RECEIVE_IDX_KEY);
}

export type DerivedAddress = { idx: number; address: string; change: boolean };

export async function scanWalletAddresses(): Promise<DerivedAddress[]> {
  const index = await getAddressIndex();
  const out: DerivedAddress[] = [];
  for (const [address, info] of index) {
    out.push({ idx: info.index, address, change: info.isChange });
  }
  return out;
}

export async function peekChangeAddressAsync(): Promise<{ idx: number; address: string }> {
  const idx = await readIndex(CHANGE_IDX_KEY);
  return { idx, address: deriveChangeAddressAt(idx) };
}

/**
 * 提交找零索引。**只前进不后退**，且走与 bumpIndex 同一把互斥锁。
 *
 * 旧实现是无条件 `set(idx + 1)`：两笔发送并发、或广播重试时传入了陈旧的 idx，
 * 索引会被写回更小的值，下一笔找零就复用了已经用过的地址——地址复用是隐私
 * 泄漏，链上分析可直接把两笔交易关联起来。
 */
export async function commitChangeAddress(idx: number): Promise<void> {
  if (!Number.isInteger(idx) || idx < 0) return;
  const key = CHANGE_IDX_KEY;
  while (indexLocks.has(key)) await indexLocks.get(key);
  let release!: () => void;
  indexLocks.set(key, new Promise<void>((r) => (release = r)));
  try {
    const current = await readIndex(key);
    const next = Math.max(current, idx + 1);
    if (next !== current) {
      await AsyncStorage.setItem(key, String(next));
      addressIndex = null;
    }
  } finally {
    indexLocks.delete(key);
    release();
  }
}

export async function clearDerivationIndices(): Promise<void> {
  await AsyncStorage.multiRemove([RECEIVE_IDX_KEY, CHANGE_IDX_KEY]);
  addressIndex = null;
}

// ── BIP32 path 工具 ──

export function parseBip32Path(path: string): number[] {
  const trimmed = path.trim().replace(/^[mM]'?\//, "").replace(/^[mM]'?$/, "");
  if (!trimmed) return [];
  return trimmed.split("/").map((part) => {
    const hardened = part.endsWith("'") || part.endsWith("h") || part.endsWith("H");
    const numStr = hardened ? part.slice(0, -1) : part;
    const num = Number.parseInt(numStr, 10);
    if (!Number.isInteger(num) || num < 0 || num >= HARDENED_OFFSET) {
      throw new Error(`Invalid path segment: ${part}`);
    }
    return hardened ? num + HARDENED_OFFSET : num;
  });
}

export function pathToString(path: number[]): string {
  if (path.length === 0) return "m";
  return (
    "m/" +
    path
      .map((p) => {
        const hardened = p >= HARDENED_OFFSET;
        return `${hardened ? p - HARDENED_OFFSET : p}${hardened ? "'" : ""}`;
      })
      .join("/")
  );
}

export async function walletInputDerivation(address: string): Promise<{
  pubkey: Uint8Array;
  fingerprint: number;
  path: number[];
  isChange: boolean;
  index: number;
}> {
  const root = getRoot();
  const info = (await getAddressIndex()).get(address);
  if (!info) throw new Error("Address not found in wallet derivation tree");
  if (!info.child.publicKey) throw new Error("Missing public key for address");
  return {
    pubkey: info.child.publicKey,
    fingerprint: root.fingerprint ?? 0,
    path: parseBip32Path(info.path),
    isChange: info.isChange,
    index: info.index,
  };
}

export function deriveKeyForPath(path: number[]): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const child = getRoot().derive(pathToString(path));
  if (!child.publicKey || !child.privateKey) {
    throw new Error("Could not derive key pair for path");
  }
  return { publicKey: child.publicKey, privateKey: new Uint8Array(child.privateKey) };
}

// ── zpub 导出 ──

function base58checkEncode(payload: Uint8Array): string {
  const checksum = doubleSha256(payload).slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58.encode(full);
}

// xpub/tpub → zpub/vpub：替换 version bytes 后重新 base58check。
const ZPUB_VERSION = new Uint8Array([0x04, 0xb2, 0x47, 0x46]); // mainnet zpub
const VPUB_VERSION = new Uint8Array([0x04, 0x5f, 0x1c, 0xf6]); // testnet vpub

function reVersion(extKey: string, version: Uint8Array): string {
  const decoded = base58.decode(extKey);
  if (decoded.length !== 82) throw new Error("Invalid extended key length");
  const payload = new Uint8Array(78);
  payload.set(version, 0);
  payload.set(decoded.slice(4, 78), 4);
  return base58checkEncode(payload);
}

/**
 * 导出账户级 zpub（主网）/ vpub（测试网）。
 * 旧实现硬编码 m/84'/0'/0'，testnet 下导出的 zpub 与实际地址树（coin type 1）
 * 不匹配，观察钱包配对必然失败。
 */
export function getAccountZpub(): string {
  assertNotDuress("export");
  const account = getRoot().derive(getAccountBasePath());
  if (!account.publicExtendedKey) throw new Error("Could not derive account xpub");
  const testnet = getNetworkModeSync() === "testnet";
  return reVersion(account.publicExtendedKey, testnet ? VPUB_VERSION : ZPUB_VERSION);
}

export function getMasterFingerprintHex(): string {
  const fp = getRoot().fingerprint ?? 0;
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, fp >>> 0, false);
  return bytesToHex(bytes);
}

// ── 生命周期 ──

export async function hasWallet(): Promise<boolean> {
  return vaultExists();
}

export function isWalletUnlocked(): boolean {
  return cachedRoot !== null;
}

export function lockWallet(): void {
  disarmIdleLock();
  lockGeneration++;
  cachedRoot = null;
  cachedReceiveAccount = null;
  cachedChangeAccount = null;
  addressIndex = null;
  if (cachedDek) {
    cachedDek.fill(0);
    cachedDek = null;
  }
  if (cachedDataKey) {
    cachedDataKey.fill(0);
    cachedDataKey = null;
  }
  isDuressMode = false;
  clearVaultsCache();
  onLockCallbacks.forEach((cb) => {
    try {
      cb();
    } catch {
      /* 单个监听器异常不影响其余 */
    }
  });
}

export async function getWalletDataKey(): Promise<Uint8Array> {
  if (cachedDataKey) return cachedDataKey;
  const child = getRoot().derive(WALLET_DATA_KEY_PATH);
  if (!child.privateKey) throw new Error("Could not derive wallet data key");
  cachedDataKey = new Uint8Array(child.privateKey);
  return cachedDataKey;
}

// ── 创建 / 导入 / 解锁 ──

function packVault(mnemonic: string, passphrase: string): string {
  const payload: VaultPlaintext = { v: 1, mnemonic, passphrase };
  return JSON.stringify(payload);
}

function unpackVault(raw: string): VaultPlaintext {
  const parsed = JSON.parse(raw) as VaultPlaintext;
  if (parsed.v !== 1 || typeof parsed.mnemonic !== "string" || typeof parsed.passphrase !== "string") {
    throw new Error("Vault corrupt");
  }
  return parsed;
}

/**
 * 生成 24 词助记词（256 位熵）。
 *
 * 熵源经由 randomness.secureRandomBytes —— 旧实现直接调 expo-crypto 的同步
 * getRandomBytes()，而后者在 __DEV__ + 调试器 attach 时会**静默退化成
 * Math.random()**，在那个状态下创建的钱包助记词可被逆推。
 */
export function generateMnemonic(): string {
  assertKeyGenerationAllowed();
  const entropy = secureRandomBytes(32);
  try {
    return entropyToMnemonic(entropy, wordlist);
  } finally {
    entropy.fill(0);
  }
}

export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isValidMnemonic(raw: string): boolean {
  return validateMnemonic(normalizeMnemonic(raw), wordlist);
}

async function initializeWallet(
  mnemonic: string,
  pin: string,
  passphrase: string,
): Promise<Wallet> {
  assertValidNewPin(pin);
  const dek = await createVault(pin, packVault(mnemonic, passphrase));
  cachedDek = dek;
  await AsyncStorage.multiSet([
    [RECEIVE_IDX_KEY, "0"],
    [CHANGE_IDX_KEY, "0"],
  ]);
  await resetFailures();
  return deriveFromRoot(primeCache(mnemonic, passphrase));
}

export async function createWallet(pin: string, passphrase = ""): Promise<Wallet> {
  // 原生与 JS KDF 不一致时拒绝建钱包：这种钱包在实现切换后解不开。
  await assertKdfParityOk();
  return initializeWallet(generateMnemonic(), pin, passphrase);
}

export async function importWallet(rawMnemonic: string, pin: string, passphrase = ""): Promise<Wallet> {
  // 原生与 JS KDF 不一致时拒绝建钱包：这种钱包在实现切换后解不开。
  await assertKdfParityOk();
  const normalized = normalizeMnemonic(rawMnemonic);
  if (!validateMnemonic(normalized, wordlist)) throw new Error("Invalid mnemonic");
  return initializeWallet(normalized, pin, passphrase);
}

export type UnlockOutcome =
  | { kind: "unlocked"; wallet: Wallet }
  | { kind: "duress"; wallet: Wallet }
  | { kind: "wrong-pin"; state: LockState; wiped: boolean }
  | { kind: "locked"; state: LockState };

/**
 * 统一解锁入口。
 *
 * 旧流程：verifyPinDetailed(600k PBKDF2 ≈ 1551ms) → unlockWallet(scrypt ≈ 89ms)
 *         ——PIN 正确时白跑一次 PBKDF2；PIN 错误时还要再跑一次胁迫 PBKDF2，共 2.9s。
 * 新流程：直接 scrypt 解开 DEK，GCM 认证标签即 PIN 校验。约 90ms。
 */
export async function unlockWithPin(pin: string): Promise<UnlockOutcome> {
  const pre = await beginAttempt();
  if (pre.locked) return { kind: "locked", state: pre };

  const gen = lockGeneration;
  try {
    const { plaintext, dek } = await openVaultWithPin(pin);
    if (lockGeneration !== gen) throw new Error("Wallet locked during unlock");
    const vault = unpackVault(plaintext);
    cachedDek = dek;
    await resetFailures();
    return { kind: "unlocked", wallet: deriveFromRoot(primeCache(vault.mnemonic, vault.passphrase)) };
  } catch (err) {
    if (!(err instanceof WrongPinError)) {
      logger.warn("Vault open failed", err);
      throw err;
    }
  }

  // 主 PIN 不对 → 尝试胁迫 PIN。两条路径都是同参数 scrypt，时序一致。
  const duress = await tryOpenDuress(pin);
  if (duress) {
    isDuressMode = true;
    // **必须清零主 PIN 失败计数。**
    //
    // beginAttempt() 是"写前递增"（防止攻击者在 KDF 返回后杀进程规避计数），
    // 所以每次解锁尝试都已经 +1 了。旧实现在胁迫分支直接 return，没有 reset ——
    // 结果：用胁迫 PIN 正常解锁 5 次，主 PIN 就被退避锁定 60 秒；10 次锁 24 小时。
    // 而且如果用户开了"多次失败后清除钱包"策略，下一次真实的手误就会把主钱包抹掉。
    //
    // 胁迫模式的全部意义是"在胁迫者面前表现得完全正常"，一个会把自己锁死的
    // 胁迫钱包正好起了反作用。
    await resetFailures();
    await invalidateBlockchainCache();
    return { kind: "duress", wallet: deriveFromRoot(primeCache(duress.mnemonic, duress.passphrase)) };
  }

  const { shouldWipe, state } = await recordFailure();
  if (shouldWipe) {
    await deleteWallet();
    return { kind: "wrong-pin", state, wiped: true };
  }
  return { kind: "wrong-pin", state, wiped: false };
}

/** 生物识别解锁：0 次 KDF，仅一次 GCM 解密。失败时调用方回退到 PIN。 */
export async function unlockWithBiometrics(prompt: string): Promise<Wallet> {
  const gen = lockGeneration;
  const { plaintext, dek } = await openVaultWithBiometrics(prompt);
  if (lockGeneration !== gen) throw new Error("Wallet locked during unlock");
  const vault = unpackVault(plaintext);
  cachedDek = dek;
  await resetFailures();
  return deriveFromRoot(primeCache(vault.mnemonic, vault.passphrase));
}

export { isBiometricUnlockEnabled, disableBiometricUnlock, BiometricKeyUnavailableError };
export { getLockState };

/** 启用生物识别快速解锁。要求钱包已解锁（持有 DEK）。 */
export async function enableBiometricFastUnlock(): Promise<void> {
  assertNotDuress("destructive");
  if (!cachedDek) throw new Error("Wallet must be unlocked to enable biometric unlock");
  await enableBiometricUnlock(cachedDek);
}

// ── 胁迫模式 ──

export function isDuress(): boolean {
  return isDuressMode;
}

export function assertNotDuress(action: "export" | "destructive"): void {
  if (isDuressMode) throw new Error(`Action ${action} blocked in duress mode`);
}

/**
 * 设置胁迫钱包。**使用独立生成的助记词**，与主 vault 无任何密码学关联——
 * 即使胁迫 payload 被完整导出并解密，主种子也不会泄露。
 * 返回诱饵钱包首地址与助记词，供向导提示用户充值 + 单独备份。
 */
export async function setupDuressEntry(
  mainPin: string,
  duressPin: string,
  duressPassphrase: string,
): Promise<{ wallet: Wallet; decoyMnemonic: string }> {
  assertNotDuress("destructive");
  // 验主 PIN：直接尝试解 vault（一次 scrypt），不需要单独的 PIN 哈希记录。
  await openVaultWithPin(mainPin);

  const decoyMnemonic = generateMnemonic();
  await setupDuress(duressPin, decoyMnemonic, duressPassphrase, (p) => p === mainPin);

  const decoyRoot = HDKey.fromMasterSeed(mnemonicToSeedSync(decoyMnemonic, duressPassphrase));
  const child = decoyRoot.derive(`${getReceiveBasePath()}/0`);
  if (!child.publicKey) throw new Error("Could not derive decoy address");
  const payment = btc.p2wpkh(child.publicKey, getBtcNetwork());
  if (!payment.address) throw new Error("Could not derive decoy address");

  return {
    wallet: {
      address: payment.address,
      publicKeyHex: bytesToHex(child.publicKey),
      path: `${getReceiveBasePath()}/0`,
      evmAddress: deriveEvmWalletFromRoot(decoyRoot).address,
      evmPath: EVM_DERIVATION_PATH,
    },
    decoyMnemonic,
  };
}

// ── 导出 / 销毁 / 改 PIN ──

/**
 * 导出助记词。**每次都要求 PIN 并真正解密 vault**。
 * 旧实现在缓存命中时完全忽略传入的 pin，函数签名看起来在做认证，实际没有。
 * 现在解密只需一次 scrypt（约 90ms），缓存明文毫无必要。
 */
// 导出类操作的统一前置。
//
// 【为什么要下沉到服务层】assertExportAllowed() 之前只在 SettingsScreen 和
// OfflineSignScreen 两个 UI 调用点里出现——任何新的调用方（新页面、深链、
// 脚本、未来的自动备份功能）都会绕过 danger 环境下的导出封锁，而策略字段
// allowSecretExport 看上去是生效的。安全策略必须建在拿得到密钥的那一层，
// 不能建在渲染层。
function assertExportPermitted(): void {
  assertNotDuress("export");
  assertExportAllowed();
}

export async function getMnemonicForExport(pin: string): Promise<string> {
  assertExportPermitted();
  const { plaintext } = await openVaultWithPin(pin);
  return unpackVault(plaintext).mnemonic;
}

export async function getPassphraseForExport(pin: string): Promise<string> {
  assertExportPermitted();
  const { plaintext } = await openVaultWithPin(pin);
  return unpackVault(plaintext).passphrase;
}

export async function getPrivateKey(): Promise<Uint8Array> {
  assertExportPermitted();
  const child = accountFor(false).deriveChild(0);
  if (!child.privateKey) throw new Error("Could not derive private key");
  return new Uint8Array(child.privateKey);
}

export async function getEvmPrivateKey(): Promise<Uint8Array> {
  assertExportPermitted();
  const child = getRoot().derive(EVM_DERIVATION_PATH);
  if (!child.privateKey) throw new Error("Could not derive EVM private key");
  return new Uint8Array(child.privateKey);
}

export function getRootUnlocked(): HDKey {
  return getRoot();
}

export async function deleteWallet(): Promise<void> {
  disarmIdleLock();
  // 先跑各模块注册的清理钩子（SQLite 交易缓存等）。放在最前是因为即使后续步骤
  // 抛错，本地留存的历史数据也已经清掉了。走 lifecycle 注册表而不是直接
  // import database，避免 wallet ↔ database 循环依赖。
  await runWalletDeletedHooks((err) => logger.warn("Wallet cleanup hook failed", err));
  lockWallet();
  clearStablecoinCache();
  await invalidateBlockchainCache();
  await clearVault();
  await clearPinState();
  await clearDuress();
  await AsyncStorage.multiRemove([RECEIVE_IDX_KEY, CHANGE_IDX_KEY]);
}

export async function resetWalletIndices(): Promise<void> {
  await AsyncStorage.multiSet([
    [RECEIVE_IDX_KEY, "0"],
    [CHANGE_IDX_KEY, "0"],
  ]);
  addressIndex = null;
}

/**
 * 改 PIN：只重新包裹 32 字节的 DEK，不重新加密 vault。
 * 旧实现要跑 4 次 KDF（verifyPin + loadMnemonic + storeMnemonic + setPin）
 * 并重新加密整个 vault，实测 3128ms；现在只需 1 次 scrypt。
 */
export async function changeWalletPin(oldPin: string, newPin: string): Promise<void> {
  assertNotDuress("destructive");
  assertValidNewPin(newPin);
  const { dek } = await openVaultWithPin(oldPin); // 解得开即证明 oldPin 正确
  await rewrapDekWithNewPin(dek, newPin);
  cachedDek = dek;
  await resetFailures();
}

// ───────────────────────────────────────────────────────────────────────────
// 关于口令词（BIP39 passphrase）
//
// 口令词现在与助记词一起存放在同一个 GCM 密封块里，而非像旧实现那样另存一份
// SHA256(SHA256(seed)) 校验哈希。
//
// 理由：那份校验哈希是可离线检验的验证器——攻击者一旦拿到助记词，就能以
// 「2 次 SHA256 + 一次 BIP39 PBKDF2」的成本高速爆破口令词。而把口令词放进
// vault 不增加任何边际风险：能读到口令词的攻击者同样能读到助记词。
//
// 可否认性由（现已使用独立助记词的）胁迫钱包提供，不再依赖口令词。
// ───────────────────────────────────────────────────────────────────────────

// ── 兼容/便捷入口 ──

/**
 * 校验 PIN 是否正确（不改变解锁状态）。
 * 实现方式是尝试解开 DEK —— GCM 认证标签即校验，一次 scrypt 约 90ms。
 * 不再需要单独存一份 PIN 哈希。
 */
export async function verifyPin(pin: string): Promise<boolean> {
  const pre = await beginAttempt();
  if (pre.locked) return false;
  try {
    await openVaultWithPin(pin);
    await resetFailures();
    return true;
  } catch (err) {
    if (err instanceof WrongPinError) {
      await recordFailure();
      return false;
    }
    throw err;
  }
}

/** 是否已设置钱包（等价于是否已有 PIN）。 */
export async function isPinSet(): Promise<boolean> {
  return vaultExists();
}
