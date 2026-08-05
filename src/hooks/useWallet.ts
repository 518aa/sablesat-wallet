import { useCallback, useEffect, useState } from "react";
import {
  createWallet,
  deleteWallet,
  hasWallet,
  importWallet,
  lockWallet,
  onLock,
  unlockWithPin,
  unlockWithBiometrics,
  isBiometricUnlockEnabled,
  BiometricKeyUnavailableError,
  type Wallet,
  type UnlockOutcome,
} from "../services/wallet";
import {
  clearAllRoles,
  readRole,
  readWatchOnlyConfig,
  saveSigningTerminalConfig,
  saveWatchOnlyConfig,
  switchRole,
  type DeviceRole,
  type SigningTerminalConfig,
  type WatchOnlyConfig,
} from "../services/deviceRole";
import { resetBlockchainChain } from "./useBlockchain";

export type WalletStatus = "loading" | "onboarding" | "locked" | "ready";

export function useWallet() {
  const [status, setStatus] = useState<WalletStatus>("loading");
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [role, setRole] = useState<DeviceRole | null>(null);
  const [watchOnly, setWatchOnly] = useState<WatchOnlyConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await readRole();
      if (cancelled) return;
      setRole(r);
      if (r === "watch_only") {
        const cfg = await readWatchOnlyConfig();
        if (cancelled) return;
        setWatchOnly(cfg);
        setStatus(cfg ? "ready" : "onboarding");
        return;
      }
      if (r === "signing_terminal") {
        // 终端持 vault（助记词），需 PIN 解锁才能签名
        const exists = await hasWallet();
        if (cancelled) return;
        setStatus(exists ? "locked" : "onboarding");
        return;
      }
      // r === "hot" 或 null：保留原 hasWallet / legacy 逻辑
      const exists = await hasWallet();
      if (cancelled) return;
      if (exists) {
        setRole("hot");
        setStatus("locked");
        return;
      }
      setStatus("onboarding");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 通过 onLock 回调响应 lockWallet() 调用（含 AppState 后台锁定），
  // 确保 React state 与模块级缓存状态同步。
  useEffect(() => {
    return onLock(() => {
      setWallet(null);
      setStatus("locked");
    });
  }, []);

  const create = useCallback(async (pin: string, passphrase?: string) => {
    setError(null);
    try {
      const w = await createWallet(pin, passphrase ?? "");
      await switchRole("hot");
      setRole("hot");
      setWallet(w);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const importMnemonic = useCallback(async (mnemonic: string, pin: string, passphrase?: string) => {
    setError(null);
    try {
      const w = await importWallet(mnemonic, pin, passphrase ?? "");
      await switchRole("hot");
      setRole("hot");
      setWallet(w);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const unlock = useCallback(async (pin: string): Promise<UnlockOutcome> => {
    setError(null);
    const outcome = await unlockWithPin(pin);
    if (outcome.kind === "unlocked" || outcome.kind === "duress") {
      // 胁迫钱包进入前清主钱包区块链缓存，防余额闪现。
      if (outcome.kind === "duress") resetBlockchainChain();
      setWallet(outcome.wallet);
      setStatus("ready");
    }
    return outcome;
  }, []);

  /** 生物识别快速解锁：0 次 KDF。失败时返回 false，由 UI 回退到 PIN 输入。 */
  const unlockBiometric = useCallback(async (prompt: string): Promise<boolean> => {
    setError(null);
    if (!(await isBiometricUnlockEnabled())) return false;
    try {
      const w = await unlockWithBiometrics(prompt);
      setWallet(w);
      setStatus("ready");
      return true;
    } catch (e) {
      if (!(e instanceof BiometricKeyUnavailableError)) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return false;
    }
  }, []);

  const lock = useCallback(() => {
    lockWallet();
    setWallet(null);
    setStatus("locked");
  }, []);

  const del = useCallback(async () => {
    setError(null);
    try {
      await deleteWallet();
      setWallet(null);
      setStatus("onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  // 观察钱包：只存 zpub 公开信息，无私钥。
  const setupWatchOnly = useCallback(async (cfg: WatchOnlyConfig) => {
    setError(null);
    try {
      await switchRole("watch_only");
      await saveWatchOnlyConfig(cfg);
      setRole("watch_only");
      setWatchOnly(cfg);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  // 离线签名终端：switchRole 清场后用 importWallet 烧入助记词（沿用 vault 加密）。
  const setupSigningTerminal = useCallback(
    async (mnemonic: string, pin: string, cfg: SigningTerminalConfig) => {
      setError(null);
      try {
        await switchRole("signing_terminal");
        const w = await importWallet(mnemonic, pin);
        await saveSigningTerminalConfig(cfg);
        setRole("signing_terminal");
        setWallet(w);
        setStatus("ready");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    [],
  );

  // 设置页"切换设备角色"：清场回 onboarding。
  const switchToOnboarding = useCallback(async () => {
    setError(null);
    try {
      await clearAllRoles();
      setRole(null);
      setWatchOnly(null);
      setWallet(null);
      setStatus("onboarding");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  return {
    status,
    wallet,
    role,
    watchOnly,
    error,
    create,
    importMnemonic,
    unlock,
    unlockBiometric,
    lock,
    delete: del,
    setupWatchOnly,
    setupSigningTerminal,
    switchToOnboarding,
  };
}
