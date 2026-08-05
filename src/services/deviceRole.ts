import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearVault } from "./vaultKey";
import { clearDerivationIndices, lockWallet } from "./wallet";
import { clearPinState } from "./pin";

// 设备主角色：互斥。一台设备同一时刻只承担一个角色，决定 onboarding 入口与
// 首屏渲染分支。借鉴 AirGap 气隙模型：私钥设备(signing_terminal)离线签名，
// 观察设备(watch_only)只读余额，热钱包(hot)则是传统单设备模式。
export type DeviceRole = "hot" | "watch_only" | "signing_terminal";

// 观察钱包配置：只存公开的 zpub，无私钥无助记词。
export type WatchOnlyConfig = {
  schemaVersion: 1;
  name: string;
  zpub: string;                  // BIP84 account-level zpub，路径 m/84'/0'/0'
  fingerprint: string;           // account 节点指纹 hex，用于显示与校验
  accountDerivation: string;     // "m/84'/0'/0'"
  network: "mainnet" | "testnet";
  createdAt: number;
};

// 离线签名终端配置：本机持助记词(沿用 vault 加密)，专做离线签名。
export type SigningTerminalConfig = {
  schemaVersion: 1;
  label: string;
  linkedFingerprints: string[];  // 可选绑定指纹白名单，空数组表示不限制
  createdAt: number;
};

const ROLE_KEY = "bitnest.role.v1";
const WATCH_ONLY_KEY = "bitnest.watch_only.v1";
const SIGNING_TERMINAL_KEY = "bitnest.signing_terminal.v1";

export async function readRole(): Promise<DeviceRole | null> {
  const v = await AsyncStorage.getItem(ROLE_KEY);
  return v === "hot" || v === "watch_only" || v === "signing_terminal" ? v : null;
}

export async function readWatchOnlyConfig(): Promise<WatchOnlyConfig | null> {
  const raw = await AsyncStorage.getItem(WATCH_ONLY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WatchOnlyConfig>;
    // Validate required fields: a corrupted/half-written record with a missing
    // `fingerprint` would crash WatchOnlyHomeScreen's render
    // (`fingerprint.toUpperCase()`). Reject instead of returning a partial obj.
    // fingerprint 必须是 8 位 hex（account 节点指纹），空串会让 PSBT 写入 fingerprint 0。
    if (
      typeof parsed.zpub !== "string" ||
      typeof parsed.fingerprint !== "string" ||
      !/^[0-9a-fA-F]{8}$/.test(parsed.fingerprint) ||
      typeof parsed.accountDerivation !== "string"
    ) {
      return null;
    }
    return parsed as WatchOnlyConfig;
  } catch {
    return null;
  }
}

export async function saveWatchOnlyConfig(cfg: WatchOnlyConfig): Promise<void> {
  await AsyncStorage.setItem(WATCH_ONLY_KEY, JSON.stringify(cfg));
}

export async function readSigningTerminalConfig(): Promise<SigningTerminalConfig | null> {
  const raw = await AsyncStorage.getItem(SIGNING_TERMINAL_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SigningTerminalConfig;
  } catch {
    return null;
  }
}

export async function saveSigningTerminalConfig(cfg: SigningTerminalConfig): Promise<void> {
  await AsyncStorage.setItem(SIGNING_TERMINAL_KEY, JSON.stringify(cfg));
}

// 角色互斥清场。进入非 hot 角色前清除热钱包相关数据(助记词/索引/金库缓存)。
// hot 角色不清除 vault，保留现有热钱包。watch_only/terminal 之间切换也互清。
export async function switchRole(role: DeviceRole): Promise<void> {
  if (role !== "hot") {
    lockWallet(); // 内部已调用 clearVaultsCache()，此处不再重复
    await clearVault();
    await clearDerivationIndices();
  }
  if (role !== "watch_only") {
    await AsyncStorage.removeItem(WATCH_ONLY_KEY);
  }
  if (role !== "signing_terminal") {
    await AsyncStorage.removeItem(SIGNING_TERMINAL_KEY);
  }
  await AsyncStorage.setItem(ROLE_KEY, role);
}

// 完全清场回到 onboarding（设置页"切换设备角色"入口用）。
export async function clearAllRoles(): Promise<void> {
  lockWallet(); // 内部已调用 clearVaultsCache()，此处不再重复
  await clearVault();
  await clearDerivationIndices();
  await clearPinState();
  await AsyncStorage.removeItem(WATCH_ONLY_KEY);
  await AsyncStorage.removeItem(SIGNING_TERMINAL_KEY);
  await AsyncStorage.removeItem(ROLE_KEY);
}
