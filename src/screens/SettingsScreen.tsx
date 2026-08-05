import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import { PinDialog } from "../components/PinDialog";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { QrCode } from "../components/QrCode";
import { ThemeToggle } from "../components/ThemeToggle";
import { useTheme } from "../hooks/useTheme";
import { hapticImpact } from "../utils/haptics";
import type { Language, ReturnTypeT } from "../i18n";
import { press } from "../theme-tokens";
import {
  changeWalletPin,
  getMnemonicForExport,
  isWalletUnlocked,
  unlockWithPin,
  verifyPin,
  isPinSet,
  resetWalletIndices,
  isDuress,
  setupDuressEntry,
  enableBiometricFastUnlock,
  isBiometricUnlockEnabled,
  disableBiometricUnlock,
} from "../services/wallet";
import { validateNewPin, setWipeThreshold, getWipeThreshold, SUGGESTED_WIPE_THRESHOLD } from "../services/pin";
import { hasBiometricHardware } from "../services/auth";
import { assertExportAllowed, SecurityPolicyError, getSecurityPolicy } from "../services/security";
import { useScreenGuard } from "../services/screenGuard";
import { isNativeKdfActive } from "../services/kdf";
import { hasDuressWallet } from "../services/duress";
import { clearVaultsCache } from "../services/vault/cache";
import { clearCachedWalletState } from "../services/blockchain";
import { invalidateBlockchainCache } from "../services/cache";
import {
  getNetworkMode,
  setNetworkMode,
  subscribe,
  type NetworkMode,
} from "../services/network-mode";
import { logger } from "../services/logger";

const MNEMONIC_REVEAL_TTL_MS = 30_000;

type Props = {
  language: Language;
  text: ReturnTypeT;
  onLanguageChange: (lang: Language) => void;
  onLock: () => void;
  onReset: () => void;
};

type PinPurpose =
  | "mnemonic"
  | "change-current"
  | "change-new"
  | "change-confirm"
  | "duress-main"
  | "duress-pin-set"
  | "duress-pin-confirm"
  | null;

export function SettingsScreen({ language, text, onLanguageChange, onLock, onReset }: Props) {
  // 助记词展示区在本页：挂载期间禁止截屏/录屏，并避免进入最近任务缩略图。
  useScreenGuard("settings");
  const [decoyMnemonic, setDecoyMnemonic] = useState<string | null>(null);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioSupported, setBioSupported] = useState(false);
  const [wipeThreshold, setWipeThresholdState] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [enabled, supported, threshold] = await Promise.all([
        isBiometricUnlockEnabled().catch(() => false),
        hasBiometricHardware().catch(() => false),
        getWipeThreshold().catch(() => null),
      ]);
      if (cancelled) return;
      setBioEnabled(enabled);
      setBioSupported(supported);
      setWipeThresholdState(threshold);
    })();
    return () => { cancelled = true; };
  }, []);

  async function toggleBiometric() {
    if (isDuress()) return;
    if (bioEnabled) {
      await disableBiometricUnlock();
      setBioEnabled(false);
      return;
    }
    if (!bioSupported) return Alert.alert("SableSat", text.biometricFallbackToPin);
    if (!getSecurityPolicy().allowBiometricFastUnlock) {
      return Alert.alert("SableSat", text.securityExportBlocked);
    }
    // 启用前必须已备份助记词：生物识别重录 / 移除设备密码会使硬件密钥失效，
    // 届时只能用 PIN 恢复；若 PIN 也忘了，助记词是唯一退路。
    Alert.alert(text.biometricEnableTitle, text.biometricEnableBody, [
      { text: text.cancel, style: "cancel" },
      {
        text: text.confirm,
        onPress: async () => {
          try {
            if (!isWalletUnlocked()) return Alert.alert("SableSat", text.walletLocked);
            await enableBiometricFastUnlock();
            setBioEnabled(true);
          } catch (err) {
            logger.warn("Enable biometric unlock failed", err);
            Alert.alert("SableSat", text.biometricFallbackToPin);
          }
        },
      },
    ]);
  }

  async function toggleWipePolicy() {
    if (isDuress()) return;
    if (wipeThreshold !== null) {
      await setWipeThreshold(null);
      setWipeThresholdState(null);
      return;
    }
    // 默认关闭。旧实现是「8 次错误直接抹除 vault」且无梯度退避——口袋误触就能
    // 归零。现在改为用户显式开启，阈值 20，且退避已是指数级。
    Alert.alert(text.wipePolicyTitle, text.wipePolicyBody.replace("{n}", String(SUGGESTED_WIPE_THRESHOLD)), [
      { text: text.cancel, style: "cancel" },
      {
        text: text.confirm,
        style: "destructive",
        onPress: async () => {
          await setWipeThreshold(SUGGESTED_WIPE_THRESHOLD);
          setWipeThresholdState(SUGGESTED_WIPE_THRESHOLD);
        },
      },
    ]);
  }
  const { theme } = useTheme();
  const [showMnemonic, setShowMnemonic] = useState(false);
  // 助记词放 ref 而非 state：React DevTools 的 state 面板可读 state，ref 不直接
  // 暴露在状态树里，降低展示窗口内被调试器读取的风险。配合 hide/unmount 立即清空。
  const mnemonicRef = useRef("");
  const [mnemonicVersion, setMnemonicVersion] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pinPurpose, setPinPurpose] = useState<PinPurpose>(null);
  const [pinError, setPinError] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [nextPin, setNextPin] = useState("");
  const [oldPin, setOldPin] = useState("");
  const [networkMode, setNetworkModeState] = useState<NetworkMode>("mainnet");
  // 二次钱包（胁迫保护）设置向导状态
  const [duressMainPin, setDuressMainPin] = useState("");
  const [duressPin, setDuressPin] = useState("");
  const [duressPassphraseVisible, setDuressPassphraseVisible] = useState(false);
  const [duressPassphraseValue, setDuressPassphraseValue] = useState("");
  const [hasDuress, setHasDuress] = useState(false);
  const [duressBusy, setDuressBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    getNetworkMode().then((m) => {
      if (mounted) setNetworkModeState(m);
    }).catch(() => {});
    const unsub = subscribe((m) => setNetworkModeState(m));
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    hasDuressWallet().then(setHasDuress).catch(() => {});
  }, []);

  function hideMnemonic() {
    setShowMnemonic(false);
    mnemonicRef.current = "";
    setSecondsLeft(0);
  }

  function closePinDialog() {
    setPinPurpose(null);
    setPinError("");
    setNextPin("");
    setOldPin("");
  }

  useEffect(() => {
    if (!showMnemonic) return undefined;

    const expiry = Date.now() + MNEMONIC_REVEAL_TTL_MS;
    setSecondsLeft(Math.ceil(MNEMONIC_REVEAL_TTL_MS / 1000));

    const ticker = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiry - Date.now()) / 1000));
      setSecondsLeft(remaining);
    }, 1000);

    const timer = setTimeout(hideMnemonic, MNEMONIC_REVEAL_TTL_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") hideMnemonic();
    });

    return () => {
      clearInterval(ticker);
      clearTimeout(timer);
      subscription.remove();
      hideMnemonic();
    };
  }, [showMnemonic]);

  const mnemonicWords = useMemo(
    () => mnemonicRef.current.split(/\s+/).filter(Boolean),
    [showMnemonic, mnemonicVersion],
  );

  async function revealMnemonic(pin: string) {
    try {
      assertExportAllowed();
      mnemonicRef.current = await getMnemonicForExport(pin);
      setMnemonicVersion((v) => v + 1);
      setShowMnemonic(true);
    } catch (error) {
      if (error instanceof SecurityPolicyError) {
        Alert.alert("SableSat", text.securityExportBlocked);
        return;
      }
      logger.warn("Failed to reveal mnemonic", error);
      Alert.alert("SableSat", text.walletLocked || "Wallet is locked. Please unlock first.");
    }
  }

  async function toggleMnemonic() {
    if (isDuress()) return;
    if (showMnemonic) {
      hideMnemonic();
      return;
    }
    // 导出助记词必须 PIN：getMnemonicForExport 需 PIN 解密 SecureStore，生物识别无法替代
    setPinPurpose("mnemonic");
    setPinError("");
  }

  async function changePin() {
    if (isDuress()) return;
    setPinError("");
    if (await isPinSet()) {
      setPinPurpose("change-current");
    } else {
      setPinPurpose("change-new");
    }
  }

  async function handlePinSubmit(pin: string) {
    setPinBusy(true);
    try {
      await handlePinSubmitInner(pin);
    } finally {
      setPinBusy(false);
    }
  }

  async function handlePinSubmitInner(pin: string) {
    if (pinPurpose === "mnemonic") {
      // 如果钱包锁定，先解锁
      if (!isWalletUnlocked()) {
        const outcome = await unlockWithPin(pin);
        if (outcome.kind !== "unlocked") {
          logger.warn("Failed to unlock wallet from settings", { kind: outcome.kind });
          return setPinError(text.pinVerifyError);
        }
        closePinDialog();
        revealMnemonic(pin);
        return;
      }

      // 钱包已解锁，只需验证 PIN
      const valid = await verifyPin(pin);
      if (!valid) return setPinError(text.pinVerifyError);
      closePinDialog();
      revealMnemonic(pin);
      return;
    }

    if (pinPurpose === "duress-main") {
      const valid = await verifyPin(pin);
      if (!valid) return setPinError(text.pinVerifyError);
      setDuressMainPin(pin);
      setPinError("");
      setPinPurpose("duress-pin-set");
      return;
    }

    if (pinPurpose === "duress-pin-set") {
      setDuressPin(pin);
      setPinError("");
      setPinPurpose("duress-pin-confirm");
      return;
    }

    if (pinPurpose === "duress-pin-confirm") {
      if (pin !== duressPin) {
        setPinError(text.pinSetupMismatch);
        setDuressPin("");
        setPinPurpose("duress-pin-set");
        return;
      }
      closePinDialog();
      setDuressPassphraseValue("");
      setDuressPassphraseVisible(true);
      return;
    }

    if (pinPurpose === "change-current") {
      const valid = await verifyPin(pin);
      if (!valid) return setPinError(text.pinVerifyError);
      setOldPin(pin);
      setPinError("");
      setPinPurpose("change-new");
      return;
    }

    if (pinPurpose === "change-new") {
      // 主 PIN 之前完全没做强度校验（isWeakPin 只在胁迫 PIN 路径被调用），
      // 用户可以把主 PIN 设成 123456。现在两条路径共用 validateNewPin。
      const issue = validateNewPin(pin);
      if (issue === "format") return setPinError(text.pinSetupFormat);
      if (issue === "weak") return setPinError(text.pinTooWeak);
      if (pin === oldPin) return setPinError(text.pinSameAsOld);
      setNextPin(pin);
      setPinError("");
      setPinPurpose("change-confirm");
      return;
    }

    if (pinPurpose === "change-confirm") {
      if (pin !== nextPin) {
        setPinError(text.pinSetupMismatch);
        setNextPin("");
        setPinPurpose("change-new");
        return;
      }
      try {
        await changeWalletPin(oldPin || pin, pin);
        closePinDialog();
        Alert.alert("SableSat", text.pinChanged);
      } catch (error) {
        logger.warn("Failed to change PIN", error);
        setPinError(text.pinVerifyError);
      }
    }
  }

  function handleReset() {
    if (isDuress()) return;
    Alert.alert(text.reset, text.riskText, [
      { text: text.cancel, style: "cancel" },
      { text: text.reset, style: "destructive", onPress: onReset }
    ]);
  }

  function handleNetworkSwitch(next: NetworkMode) {
    if (next === networkMode) return;
    const label = next === "testnet" ? text.networkTestnet : text.networkMainnet;
    Alert.alert(
      text.networkSwitchTitle.replace("{mode}", label),
      text.networkSwitchBody,
      [
        { text: text.cancel, style: "cancel" },
        {
          text: text.networkSwitchAction,
          style: "destructive",
          onPress: async () => {
            try {
              await resetWalletIndices();
              clearVaultsCache();
              await clearCachedWalletState();
              await invalidateBlockchainCache(); // 清除内存中的区块链数据缓存（余额、交易记录）
              await AsyncStorage.removeItem("bitnest.price.cny.cache"); // 清除价格缓存
              await setNetworkMode(next);
              onLock();
            } catch (err) {
              logger.warn("Network switch failed", err);
              Alert.alert("SableSat", err instanceof Error ? err.message : "Switch failed");
            }
          },
        },
      ],
    );
  }

  // 助记词**不提供**剪贴板复制。Android 上任意 App 可读剪贴板，iOS 通用剪贴板
  // 会同步到同一 Apple ID 的其他设备——30 秒自动清空远不足以防住这两条路径。
  // 改为「屏幕显示 + 手抄 + 逐词核对」。


  // 二次钱包口令提交：调用 setupDuressEntry，成功后显示诱饵地址提示充值。
  // 二次钱包口令提交：调用 setupDuressEntry（含 scrypt 加密 payload，~2-4s）。
  // 期间显示 LoadingOverlay（动态旋转 + 文字），避免用户以为卡死。
  async function handleDuressPassphraseSubmit() {
    const passphrase = duressPassphraseValue;
    setDuressPassphraseVisible(false);
    setDuressBusy(true);
    try {
      const { wallet: decoy, decoyMnemonic } = await setupDuressEntry(duressMainPin, duressPin, passphrase);
      setHasDuress(true);
      setDuressMainPin("");
      setDuressPin("");
      setDuressPassphraseValue("");
      // 诱饵钱包现在用的是**独立**助记词（不再是主助记词 + 不同口令词），
      // 因此必须单独备份——否则诱饵里的资金无法恢复。
      Alert.alert(
        "SableSat",
        text.duressSetupSuccess.replace("{address}", decoy.address) +
          "\n\n" +
          text.duressBackupDecoy,
        [{ text: text.confirm, onPress: () => setDecoyMnemonic(decoyMnemonic) }],
      );
    } catch (error) {
      logger.warn("Failed to setup duress wallet", error);
      const msg = error instanceof Error ? error.message : "";
      Alert.alert("SableSat", msg || text.duressSetupFailed);
    } finally {
      setDuressBusy(false);
    }
  }

  function openDuressSetup() {
    hapticImpact("light");
    if (hasDuress) {
      Alert.alert(text.duressExistsTitle, text.duressExistsBody, [
        { text: text.cancel, style: "cancel" },
        { text: text.passphraseConfirm, onPress: () => { setPinPurpose("duress-main"); setPinError(""); } },
      ]);
      return;
    }
    setPinPurpose("duress-main");
    setPinError("");
  }

  function pinTitle() {
    if (pinPurpose === "duress-main") return text.duressMainPinTitle;
    if (pinPurpose === "duress-pin-set") return text.duressPinSetTitle;
    if (pinPurpose === "duress-pin-confirm") return text.duressPinConfirmTitle;
    if (pinPurpose === "mnemonic") {
      return isWalletUnlocked() ? text.pinVerifyTitle : text.unlockTitle;
    }
    if (pinPurpose === "change-current") return text.currentPinTitle;
    if (pinPurpose === "change-new") return text.newPinTitle;
    if (pinPurpose === "change-confirm") return text.newPinConfirmTitle;
    return text.pinVerifyTitle;
  }

  function pinSubtitle() {
    if (pinPurpose === "duress-main") return text.duressMainPinSubtitle;
    if (pinPurpose === "duress-pin-set" || pinPurpose === "duress-pin-confirm") return text.pinSetupSubtitle;
    if (pinPurpose === "mnemonic") {
      return isWalletUnlocked() ? text.pinVerifySubtitle : text.unlockToExportMnemonic;
    }
    if (pinPurpose === "change-new" || pinPurpose === "change-confirm") return text.pinSetupSubtitle;
    return text.pinVerifySubtitle;
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: theme.bg }]}>
      <Text style={[styles.pageTitle, { color: theme.text }]}>{text.settings}</Text>

      <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>{text.securityGroup}</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <SettingRow label="01" title={text.backup} value={showMnemonic ? text.hide : text.backedUp} tone={theme.incoming} onPress={toggleMnemonic} />
        <View style={[styles.separator, { backgroundColor: theme.border }]} />
        <SettingRow label="02" title={text.changePin} value="PIN" tone={theme.textSecondary} onPress={changePin} />
        <SettingRow
          label="02b"
          title={text.biometricUnlockAction}
          value={bioEnabled ? "✓" : text.off}
          tone={bioEnabled ? theme.incoming : theme.textSecondary}
          onPress={toggleBiometric}
        />
        <SettingRow
          label="02c"
          title={text.wipePolicyTitle}
          value={wipeThreshold === null ? text.off : String(wipeThreshold)}
          tone={wipeThreshold === null ? theme.textSecondary : theme.outgoing}
          onPress={toggleWipePolicy}
        />
        <View style={[styles.noteRow, { borderTopColor: theme.border }]}>
          <Text style={[styles.noteText, { color: theme.textSecondary }]}>{text.riskText}</Text>
        </View>
      </View>

      {showMnemonic && (
        <View style={[styles.mnemonicBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}>
          <View style={[styles.mnemonicHeader, { borderBottomColor: theme.inputBorder }]}>
            <Text style={[styles.mnemonicCountdown, { color: theme.outgoing }]}>
              {text.mnemonicHideIn.replace("{seconds}", String(secondsLeft))}
            </Text>
            <Text style={[styles.mnemonicWarning, { color: theme.outgoing }]}>{text.mnemonicNoScreenshot}</Text>
          </View>
          <Text style={[styles.mnemonicHint, { color: theme.textSecondary }]}>{text.mnemonicTranscribeHint}</Text>
          <View style={styles.mnemonicGrid}>
            {mnemonicWords.map((word, idx) => (
              <View key={`${idx}-${word}`} style={[styles.mnemonicCell, { borderColor: theme.inputBorder }]}>
                <Text style={[styles.mnemonicIdx, { color: theme.textMuted }]}>{idx + 1}</Text>
                <Text
                  selectable={false}
                  style={[styles.mnemonicWord, { color: theme.text }]}
                >
                  {word}
                </Text>
              </View>
            ))}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={text.copy} hitSlop={8} style={[styles.copyMnemonicBtn, { backgroundColor: theme.surface }]}>
            <Text style={[styles.copyMnemonicText, { color: theme.text }]}>{text.copy}</Text>
          </Pressable>
        </View>
      )}

      <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>{text.preferencesGroup}</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={[styles.row, { borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
          <Text style={[styles.rowTitle, { color: theme.text }]}>{text.theme}</Text>
          <ThemeToggle />
        </View>
        <View style={styles.langRow}>
          <Text style={[styles.rowTitle, { color: theme.text }]}>{text.language}</Text>
          {(["zh", "en"] as Language[]).map((lang) => (
            <Pressable
              key={lang}
              onPress={() => { hapticImpact("light"); onLanguageChange(lang); }}
              style={[styles.langBtn, { backgroundColor: language === lang ? theme.primaryButton : theme.input, borderColor: theme.inputBorder }]}
            >
              <Text style={[styles.langText, { color: language === lang ? theme.primaryButtonText : theme.textMuted }]}>
                {lang === "zh" ? "中文" : "EN"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Pressable
        onPress={() => { hapticImpact("heavy"); handleReset(); }}
        accessibilityRole="button"
        accessibilityLabel={text.reset}
        style={({ pressed }) => [
          styles.resetRow,
          { backgroundColor: theme.card, borderColor: theme.border },
          pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
        ]}
      >
        <Text style={[styles.resetIcon, { color: theme.outgoing }]}>×</Text>
        <Text style={[styles.resetText, { color: theme.outgoing }]}>{text.reset}</Text>
      </Pressable>

      <Text style={[styles.groupLabel, { color: theme.textSecondary }]}>{text.advancedGroup}</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.langRow}>
          <Text style={[styles.rowTitle, { color: theme.text }]}>{text.networkMode}</Text>
          {(["mainnet", "testnet"] as NetworkMode[]).map((mode) => (
            <Pressable
              key={mode}
              onPress={() => { hapticImpact("light"); handleNetworkSwitch(mode); }}
              style={[styles.langBtn, { backgroundColor: networkMode === mode ? theme.primaryButton : theme.input, borderColor: theme.inputBorder }]}
            >
              <Text style={[styles.langText, { color: networkMode === mode ? theme.primaryButtonText : theme.textMuted }]}>
                {mode === "mainnet" ? text.networkMainnet : text.networkTestnet}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.separator, { backgroundColor: theme.border }]} />
        {!isDuress() && (
          <SettingRow label="03" title={text.accountOptions} value={hasDuress ? "✓" : text.accountOptionsHint} tone={hasDuress ? theme.incoming : theme.textSecondary} onPress={openDuressSetup} />
        )}
      </View>

      <PinDialog
        visible={pinPurpose !== null}
        title={pinTitle()}
        subtitle={pinSubtitle()}
        errorText={pinError || undefined}
        cancelLabel={text.cancel}
        onPinEntered={handlePinSubmit}
        onCancel={closePinDialog}
        busy={pinBusy}
        busyLabel={text.busyUnlocking}
      />
      <Modal
        visible={duressPassphraseVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setDuressPassphraseVisible(false)}
      >
        <View style={[styles.passphraseOverlay]}>
          <View style={[styles.passphraseCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.passphraseTitle, { color: theme.text }]}>{text.duressSetupTitle}</Text>
            <Text style={[styles.passphraseHint, { color: theme.textSecondary }]}>{text.duressSetupBody}</Text>
            <Text style={[styles.passphraseHint, { color: theme.textSecondary }]}>{text.duressPassphraseHint}</Text>
            <TextInput
              value={duressPassphraseValue}
              onChangeText={setDuressPassphraseValue}
              placeholder={text.duressPassphrasePlaceholder}
              placeholderTextColor={theme.textMuted}
              style={[styles.passphraseInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={handleDuressPassphraseSubmit}
            />
            <View style={styles.passphraseActions}>
              <Pressable
                onPress={() => { setDuressPassphraseVisible(false); setDuressPassphraseValue(""); }}
                accessibilityRole="button"
                accessibilityLabel={text.cancel}
                style={[styles.passphraseSkipBtn, { borderColor: theme.inputBorder }]}
              >
                <Text style={[styles.passphraseSkipText, { color: theme.textSecondary }]}>{text.cancel}</Text>
              </Pressable>
              <Pressable
                onPress={handleDuressPassphraseSubmit}
                accessibilityRole="button"
                accessibilityLabel={text.duressPassphraseConfirm}
                style={[styles.passphraseConfirmBtn, { backgroundColor: theme.primaryButton }]}
              >
                <Text style={[styles.passphraseConfirmText, { color: theme.primaryButtonText }]}>{text.duressPassphraseConfirm}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <LoadingOverlay visible={duressBusy} label={text.duressSetupBusy} />
    </ScrollView>
  );
}

function SettingRow({ label, title, value, tone, onPress }: {
  label: string;
  title: string;
  value: string;
  tone?: string;
  onPress?: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7, transform: [{ scale: press.scale }] }]}
    >
      <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
      <Text style={[styles.rowValue, { color: tone ?? theme.textMuted }]}>{value}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 12, paddingBottom: 112, gap: 10 },
  pageTitle: { fontSize: 20, fontWeight: "800", textAlign: "center", marginBottom: 6 },
  groupLabel: { fontSize: 12, fontWeight: "800", marginTop: 5 },
  group: { borderRadius: 8, borderWidth: 1, overflow: "hidden" },
  row: { minHeight: 50, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10 },
  rowTitle: { flex: 1, fontSize: 13, fontWeight: "800" },
  rowValue: { fontSize: 12, fontWeight: "700" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 12 },
  noteRow: { borderTopWidth: 1, paddingHorizontal: 12, paddingVertical: 12 },
  noteText: { fontSize: 12, lineHeight: 18 },
  mnemonicBox: { padding: 14, borderRadius: 8, borderWidth: 1, gap: 10 },
  mnemonicHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, paddingBottom: 8, borderBottomWidth: 1 },
  mnemonicCountdown: { fontSize: 12, fontWeight: "800" },
  mnemonicWarning: { fontSize: 11, fontWeight: "800" },
  mnemonicHint: { fontSize: 12, lineHeight: 17 },
  mnemonicGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  mnemonicCell: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, borderWidth: 1, minWidth: 88 },
  mnemonicIdx: { fontSize: 10, fontWeight: "800", minWidth: 16 },
  mnemonicWord: { fontSize: 13, fontWeight: "800" },
  mnemonicText: { fontSize: 13, lineHeight: 21 },
  langRow: { minHeight: 50, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 8 },
  langBtn: { minHeight: 30, paddingHorizontal: 10, borderRadius: 7, borderWidth: 1, justifyContent: "center" },
  langText: { fontWeight: "800", fontSize: 12 },
  resetRow: { minHeight: 50, borderRadius: 8, borderWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10 },
  resetIcon: { fontSize: 22, fontWeight: "900", width: 22, textAlign: "center" },
  resetText: { flex: 1, fontSize: 13, fontWeight: "800" },
  copyMnemonicBtn: { minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  copyMnemonicText: { fontSize: 13, fontWeight: "800" },
  // BIP39 passphrase modal
  passphraseOverlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", padding: 24 },
  passphraseCard: { borderRadius: 12, borderWidth: 1, padding: 20, gap: 12 },
  passphraseTitle: { fontSize: 18, fontWeight: "900", textAlign: "center" },
  passphraseHint: { fontSize: 13, lineHeight: 18, textAlign: "center", marginBottom: 4 },
  passphraseInput: { minHeight: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 15, fontWeight: "600" },
  passphraseActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  passphraseSkipBtn: { flex: 1, minHeight: 44, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  passphraseSkipText: { fontSize: 14, fontWeight: "800" },
  passphraseConfirmBtn: { flex: 1, minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  passphraseConfirmText: { fontSize: 14, fontWeight: "800" },
});
