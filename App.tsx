// ⚠️ 必须是第一个 import：ESM 的 import 会全部提升到模块体之前执行，
// polyfill 写在文件中部会导致 @noble/hashes 在加载时读到 undefined 的 crypto。
import { assertEntropyAvailable } from "./src/polyfills";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  ErrorUtils,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";

import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeContext, type ThemeMode } from "./src/hooks/useTheme";
import { useWallet } from "./src/hooks/useWallet";
import { lockWallet, isBiometricUnlockEnabled } from "./src/services/wallet";
import { isAuthInProgress } from "./src/services/auth";
import { isSensitiveScreenActive } from "./src/services/screenGuard";
import { getNetworkMode } from "./src/services/network-mode";
import { t, type Language, type ReturnTypeT } from "./src/i18n";
import { TabNavigator } from "./src/navigation/TabNavigator";
import { PinDialog } from "./src/components/PinDialog";
import { getDeviceSecurityState } from "./src/services/security";
import { logger } from "./src/services/logger";
import { themes, dark } from "./src/theme";
import { WatchOnlyImportScreen } from "./src/screens/WatchOnlyImportScreen";
import { SigningTerminalSetupScreen } from "./src/screens/SigningTerminalSetupScreen";
import { WatchOnlyHomeScreen } from "./src/screens/WatchOnlyHomeScreen";
import { WatchOnlySendScreen } from "./src/screens/WatchOnlySendScreen";
import { WatchOnlyReceiveScreen } from "./src/screens/WatchOnlyReceiveScreen";
import { OfflineSignScreen } from "./src/screens/OfflineSignScreen";

const APP_NAME = "SableSat";
// 前台切换宽限期。旧实现是「任何一次进入 background 都立即锁定」，用户切个 App
// 回来就要重新解锁。削弱的是「切后台后手机立刻被抢走」这一窄场景，
// 因此从敏感界面离开时不给宽限（见 AppState 监听）。
const FOREGROUND_GRACE_MS = 30_000;
const THEME_KEY = "sablesat.theme";
const styleArtwork = {
  sable: require("./assets/sablesat-style-sable.jpg"),
  porcelain: require("./assets/sablesat-style-porcelain.jpg"),
  aurora: require("./assets/sablesat-style-aurora.jpg")
} as const;

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [language, setLanguage] = useState<Language>("zh");
  const [mode, setMode] = useState<ThemeMode>("porcelain");
  const text = t(language) as ReturnTypeT;
  const theme = themes[mode];
  const {
    status,
    wallet,
    role,
    watchOnly,
    create,
    importMnemonic,
    unlock,
    unlockBiometric,
    lock,
    delete: deleteW,
    setupWatchOnly,
    setupSigningTerminal,
    switchToOnboarding,
  } = useWallet();

  const [onboardingStage, setOnboardingStage] = useState<"role-select" | "hot" | "watch-only" | "signing-terminal">("role-select");
  const [watchScreen, setWatchScreen] = useState<"home" | "send" | "receive">("home");
  const [watchRefreshKey, setWatchRefreshKey] = useState(0);
  const [watchLocked, setWatchLocked] = useState(false);
  const backgroundedAtRef = useRef(0);
  const [entropyError, setEntropyError] = useState<string | null>(null);

  // 启动自检：熵源不可用时必须拒绝启动，绝不能用退化的随机数生成助记词。
  useEffect(() => {
    try {
      assertEntropyAvailable();
    } catch (err) {
      logger.error("Entropy self-check failed", err);
      setEntropyError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 启动即把持久化的网络模式读进内存缓存。
  //
  // 【为什么是个真 bug】getNetworkModeSync() 在 cachedMode 未加载时返回 "mainnet"，
  // 而 loadMode() 此前**只在 SettingsScreen 挂载时**才被触发。于是一个设置成
  // testnet 的用户，在打开设置页之前，所有派生都按 coin type 0'（主网）走：
  // 单签地址树、金库的 m/48'/0'/{account}'/2'、地址编码前缀全是主网的。
  // 等他点进一次设置页，cachedMode 翻成 testnet，**同一个金库派生出的地址整个
  // 变了一套** —— 余额瞬间归零、UTXO 全消失。这是"金库余额不稳定"里最难查的
  // 那一类：它不随网络抖动，而是随用户有没有进过设置页。
  useEffect(() => {
    void getNetworkMode().catch((err) => logger.warn("Failed to load network mode", err));
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state: string) => {
      // iOS 系统弹窗（生物识别/通知/控制中心）会让 app 瞬态进入 inactive。
      // 只有真后台(background)与非认证中的 inactive 才计入离开时刻。
      if (state === "background" || (state === "inactive" && !isAuthInProgress())) {
        backgroundedAtRef.current = Date.now();
        // 从敏感界面离开：不给宽限期，立即锁定。
        // 数据源改为 screenGuard 的引用计数——旧的 sensitiveScreenRef 全项目
        // 没有任何地方写入 true，这条分支从未执行过。
        if (isSensitiveScreenActive()) {
          backgroundedAtRef.current = 0;
          lockWallet();
        }
      } else if (state === "active") {
        const leftAt = backgroundedAtRef.current;
        backgroundedAtRef.current = 0;
        // 短时切换宽限期：去相册看一眼收款码、切到别的 App 复制地址、系统弹通知
        // ——这些场景下强制重新解锁纯粹是折磨。超过宽限期才锁。
        if (leftAt && Date.now() - leftAt > FOREGROUND_GRACE_MS) {
          lockWallet();
        }
      }
    });
    AsyncStorage.getItem(THEME_KEY).then((stored) => {
      if (stored === "sable" || stored === "porcelain" || stored === "aurora") setMode(stored);
      else if (stored === "dark") setMode("sable");
      else if (stored === "light") setMode("porcelain");
    });
    return () => subscription.remove();
  }, []);

  const handleModeChange = useCallback((next: ThemeMode) => {
    setMode(next);
    AsyncStorage.setItem(THEME_KEY, next).catch((error) => {
      logger.warn("Failed to persist theme preference", error);
    });
  }, []);

  const contextValue = React.useMemo(
    () => ({
      theme,
      mode,
      setMode: handleModeChange,
      toggle: () => handleModeChange(mode === "sable" ? "porcelain" : mode === "porcelain" ? "aurora" : "sable"),
    }),
    [theme, mode, handleModeChange]
  );

  function renderContent() {
    if (status === "loading") {
      return (
        <SafeAreaView style={[styles.loading, { backgroundColor: theme.bg }]}>
          <StatusBar style={mode === "porcelain" ? "dark" : "light"} />
          <ActivityIndicator color={theme.accent} />
          <Text style={{ color: theme.textMuted }}>{text.loading}</Text>
        </SafeAreaView>
      );
    }
    if (status === "locked") {
      return (
        <UnlockView
          theme={theme}
          mode={mode}
          text={text}
          onBiometricUnlock={() => unlockBiometric(text.biometricPrompt)}
          onUnlock={async (pin) => {
            // 旧流程：verifyPinDetailed(600k PBKDF2 ≈ 1551ms) → unlockWallet(scrypt ≈ 89ms)
            //         PIN 正确时白跑一次 PBKDF2，PIN 错误时还要再跑一次胁迫 PBKDF2（共 2.9s）。
            // 新流程：直接 scrypt 解开 DEK，GCM 认证标签即 PIN 校验（约 90ms）。
            const outcome = await unlock(pin);
            switch (outcome.kind) {
              case "unlocked":
              case "duress":
                return null;
              case "locked": {
                const remaining = Math.max(0, Math.ceil(((outcome.state.unlockAtMs ?? 0) - Date.now()) / 1000));
                return text.pinLocked.replace("{seconds}", String(remaining));
              }
              case "wrong-pin": {
                if (outcome.wiped) return text.pinWipedAfterFailures;
                if (outcome.state.locked) {
                  const remaining = Math.max(0, Math.ceil(((outcome.state.unlockAtMs ?? 0) - Date.now()) / 1000));
                  return text.pinLocked.replace("{seconds}", String(remaining));
                }
                if (outcome.state.attemptsUntilWipe !== undefined && outcome.state.attemptsUntilWipe <= 5) {
                  return text.pinAttemptsRemaining.replace("{n}", String(outcome.state.attemptsUntilWipe));
                }
                return text.pinVerifyError;
              }
            }
          }}
        />
      );
    }
    if (status === "onboarding") {
      if (onboardingStage === "watch-only") {
        return (
          <WatchOnlyImportScreen
            text={text}
            onSubmit={async (cfg) => { await setupWatchOnly(cfg); }}
            onBack={() => setOnboardingStage("role-select")}
          />
        );
      }
      if (onboardingStage === "signing-terminal") {
        return (
          <SigningTerminalSetupScreen
            text={text}
            onSubmit={async (mnemonic, pin, label) => {
              await setupSigningTerminal(mnemonic, pin, {
                schemaVersion: 1,
                label,
                linkedFingerprints: [],
                createdAt: Date.now(),
              });
            }}
            onBack={() => setOnboardingStage("role-select")}
          />
        );
      }
      if (onboardingStage === "hot") {
        return (
          <OnboardingView
            theme={theme}
            mode={mode}
            text={text}
            language={language}
            onLanguageChange={setLanguage}
            onCreate={() => setPendingPin({ mode: "create" })}
            onImport={(mnemonic) => {
              setImportText(mnemonic);
              setPendingPin({ mode: "import" });
            }}
          />
        );
      }
      return (
        <RoleSelectView
          theme={theme}
          mode={mode}
          text={text}
          language={language}
          onLanguageChange={setLanguage}
          onSelect={(r) => setOnboardingStage(r)}
        />
      );
    }
    if (status === "ready") {
      const statusBarStyle: "light" | "dark" = mode === "porcelain" ? "dark" : "light";
      if (role === "watch_only" && watchOnly) {
        if (watchLocked) {
          return (
            <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
              <StatusBar style={statusBarStyle} />
              <View style={styles.unlockWrap}>
                <Text style={[styles.unlockTitle, { color: theme.text }]}>{text.appName}</Text>
                <Text style={[styles.unlockSubtitle, { color: theme.textSecondary }]}>{text.roleWatchOnly}</Text>
                <Pressable style={[styles.primaryButton, { backgroundColor: theme.primaryButton }]} onPress={() => setWatchLocked(false)}>
                  <Text style={[styles.primaryButtonText, { color: theme.primaryButtonText }]}>{text.unlockAction}</Text>
                </Pressable>
              </View>
            </SafeAreaView>
          );
        }
        if (watchScreen === "send") {
          return (
            <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
              <StatusBar style={statusBarStyle} />
              <WatchOnlySendScreen
                text={text}
                watchOnly={watchOnly}
                onBack={() => {
                  setWatchScreen("home");
                  setWatchRefreshKey(prev => prev + 1);
                }}
              />
            </SafeAreaView>
          );
        }
        if (watchScreen === "receive") {
          return (
            <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
              <StatusBar style={statusBarStyle} />
              <WatchOnlyReceiveScreen
                text={text}
                watchOnly={watchOnly}
                onBack={() => setWatchScreen("home")}
              />
            </SafeAreaView>
          );
        }
        return (
          <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
            <StatusBar style={statusBarStyle} />
            <WatchOnlyHomeScreen
              key={watchRefreshKey}
              text={text}
              language={language}
              watchOnly={watchOnly}
              onReceive={() => setWatchScreen("receive")}
              onSend={() => setWatchScreen("send")}
              onLock={() => setWatchLocked(true)}
              onSwitchRole={() => { setWatchScreen("home"); setWatchLocked(false); void switchToOnboarding(); }}
            />
          </SafeAreaView>
        );
      }
      if (role === "signing_terminal") {
        if (!wallet) return null;
        return (
          <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
            <StatusBar style={statusBarStyle} />
            <OfflineSignScreen
              text={text}
              wallet={wallet}
              onBack={() => {
                Alert.alert(
                  text.signTerminalLockTitle || text.roleSwitchTitle,
                  text.signTerminalLockBody || text.roleSwitchBody,
                  [
                    { text: text.cancel, style: "cancel" },
                    {
                      text: text.signTerminalLockAction || text.roleSwitchAction,
                      style: "default",
                      onPress: () => lock()
                    },
                    {
                      text: text.signTerminalResetAction || text.signTerminalResetFallback,
                      style: "destructive",
                      onPress: () => { setWatchScreen("home"); setWatchLocked(false); void switchToOnboarding(); }
                    },
                  ],
                );
              }}
            />
          </SafeAreaView>
        );
      }
      if (wallet) {
        return (
          <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
            <StatusBar style={statusBarStyle} />
            <TabNavigator
              wallet={wallet}
              language={language}
              text={text}
              onLanguageChange={setLanguage}
              onLock={lock}
              onReset={async () => {
                try {
                  await deleteW();
                  await switchToOnboarding();
                  setOnboardingStage("role-select");
                } catch (error) {
                  logger.warn("Failed to reset wallet", error);
                  Alert.alert(APP_NAME, text.resetFailed);
                }
              }}
            />
          </SafeAreaView>
        );
      }
    }
    return null;
  }

  const [pendingPin, setPendingPin] = useState<null | { mode: "create" | "import" }>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [pinStep, setPinStep] = useState<"set" | "confirm">("set");
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");
  const [importText, setImportText] = useState("");

  // BIP39 口令词对话框状态
  const [passphraseVisible, setPassphraseVisible] = useState(false);
  const [passphraseValue, setPassphraseValue] = useState("");
  const [passphraseError, setPassphraseError] = useState("");
  const [passphrasePending, setPassphrasePending] = useState<null | {
    mode: "create" | "import" | "unlock";
    pin: string;
    mnemonic?: string;
  }>(null);

  useEffect(() => {
    if (pendingPin) {
      setPinStep("set");
      setPinValue("");
      setPinError("");
    }
  }, [pendingPin]);

  async function handlePinDialogSubmit(pin: string) {
    if (!pendingPin) return;
    if (pinStep === "set") {
      setPinValue(pin);
      setPinStep("confirm");
      setPinError("");
      return;
    }
    if (pin !== pinValue) {
      setPinError(text.pinSetupMismatch);
      setPinStep("set");
      setPinValue("");
      return;
    }
    // PIN 已确认 → 进入 BIP39 口令词步骤（可选）
    setPendingPin(null);
    setPinValue("");
    setPinError("");
    setPassphraseValue("");
    setPassphraseError("");
    setPassphrasePending({
      mode: pendingPin.mode,
      pin,
      mnemonic: pendingPin.mode === "import" ? importText : undefined,
    });
    setPassphraseVisible(true);
  }

  /**
   * @param override 显式传入口令词，绕过 state。
   *
   * 【为什么需要】"跳过"按钮旧实现是 `setPassphraseValue(""); handlePassphraseSubmit();`
   * —— setState 是异步的，同一次事件里 handlePassphraseSubmit 读到的仍是闭包里
   * 的**旧** passphraseValue。用户先输了口令词再点跳过，那个口令词照样会被用上，
   * 派生出的钱包与用户预期完全不同（地址对不上、余额是空的），而且用户不知道
   * 自己的钱包带了口令词，日后无法恢复。
   */
  async function handlePassphraseSubmit(override?: string) {
    if (!passphrasePending) return;
    const passphrase = (override ?? passphraseValue).trim();
    setPassphraseError("");
    setBusyAction(
      passphrasePending.mode === "create" ? text.busyCreatingWallet :
      passphrasePending.mode === "import" ? text.busyImportingWallet :
      text.busyUnlocking,
    );
    await new Promise((r) => setTimeout(r, 60));
    try {
      if (passphrasePending.mode === "create") {
        await create(passphrasePending.pin, passphrase);
      } else if (passphrasePending.mode === "import") {
        await importMnemonic(importText, passphrasePending.pin, passphrase);
      }
      setPassphraseVisible(false);
      setPassphrasePending(null);
      setPassphraseValue("");
      setImportText("");
    } catch (error) {
      logger.warn("Failed to create/import/unlock wallet", error);
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes("passphrase") || detail.includes("Passphrase")) {
        setPassphraseError(text.passphraseVerifyError || detail);
      } else {
        Alert.alert(APP_NAME, detail);
        setPassphraseVisible(false);
        setPassphrasePending(null);
        setPassphraseValue("");
        if (passphrasePending.mode === "import") setImportText("");
      }
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <ThemeContext.Provider value={contextValue}>
      <AppErrorBoundary theme={theme} mode={mode}>
        {renderContent()}
        <PinDialog
          visible={pendingPin !== null}
          title={pinStep === "set" ? text.pinSetupTitle : text.pinSetupConfirm}
          subtitle={pinStep === "set" ? text.pinSetupSubtitle : undefined}
          errorText={pinError || undefined}
          cancelLabel={text.cancel}
          onPinEntered={handlePinDialogSubmit}
          onCancel={() => {
            setPendingPin(null);
            setPinValue("");
            setPinError("");
            setImportText("");
          }}
          busy={!!busyAction}
          busyLabel={busyAction ?? undefined}
        />
        <Modal
          visible={passphraseVisible}
          transparent
          animationType="fade"
          onRequestClose={() => {}}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.passphraseOverlay}
          >
            <View style={[styles.passphraseCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.passphraseTitle, { color: theme.text }]}>
                {text.passphraseTitle || "BIP39 Passphrase"}
              </Text>
              <Text style={[styles.passphraseHint, { color: theme.textSecondary }]}>
                {text.passphraseHint || "Optional. Adds a second factor to your seed. Leave empty if you haven't set one. You must remember this exact phrase — there is no recovery without it."}
              </Text>
              <TextInput
                value={passphraseValue}
                onChangeText={setPassphraseValue}
                placeholder={text.passphrasePlaceholder || "Enter passphrase (optional)"}
                placeholderTextColor={theme.textMuted}
                style={[styles.passphraseInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                returnKeyType="done"
                onSubmitEditing={() => void handlePassphraseSubmit()}
              />
              {passphraseError ? (
                <Text style={[styles.passphraseError, { color: theme.outgoing }]}>{passphraseError}</Text>
              ) : null}
              <View style={styles.passphraseActions}>
                {passphrasePending?.mode !== "unlock" && (
                  <Pressable
                    onPress={() => {
                      // 跳过口令词：显式传空串，不依赖 setState 的异步生效。
                      setPassphraseValue("");
                      void handlePassphraseSubmit("");
                    }}
                    style={[styles.passphraseSkipBtn, { borderColor: theme.inputBorder }]}
                  >
                    <Text style={[styles.passphraseSkipText, { color: theme.textSecondary }]}>
                      {text.passphraseSkip || "Skip"}
                    </Text>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => void handlePassphraseSubmit()}
                  style={[styles.passphraseConfirmBtn, { backgroundColor: theme.primaryButton }]}
                >
                  <Text style={[styles.passphraseConfirmText, { color: theme.primaryButtonText }]}>
                    {text.passphraseConfirm || "Confirm"}
                  </Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </AppErrorBoundary>
    </ThemeContext.Provider>
  );
}

function RoleSelectView({
  theme,
  mode,
  text,
  language,
  onLanguageChange,
  onSelect,
}: {
  theme: typeof dark;
  mode: ThemeMode;
  text: ReturnTypeT;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onSelect: (role: "hot" | "watch-only" | "signing-terminal") => void;
}) {
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style={mode === "porcelain" ? "dark" : "light"} />
      <ScrollView contentContainerStyle={styles.onboarding}>
        <View style={styles.hero}>
          <View style={styles.logoRow}>
            <Text style={[styles.logoBitcoin, { color: theme.accent }]}>₿</Text>
            <Text style={[styles.logoText, { color: theme.text }]}>{APP_NAME}</Text>
          </View>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{text.roleSelectTitle}</Text>
          <Text style={[styles.roleSelectHint, { color: theme.textMuted }]}>{text.roleSelectHint}</Text>
        </View>

        <Pressable style={[styles.roleCard, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => onSelect("hot")}>
          <Text style={[styles.roleTitle, { color: theme.text }]}>{text.roleHot}</Text>
          <Text style={[styles.roleHint, { color: theme.textSecondary }]}>{text.roleHotHint}</Text>
        </Pressable>

        <Pressable style={[styles.roleCard, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => onSelect("watch-only")}>
          <Text style={[styles.roleTitle, { color: theme.text }]}>{text.roleWatchOnly}</Text>
          <Text style={[styles.roleHint, { color: theme.textSecondary }]}>{text.roleWatchOnlyHint}</Text>
        </Pressable>

        <Pressable style={[styles.roleCard, { backgroundColor: theme.card, borderColor: theme.border }]} onPress={() => onSelect("signing-terminal")}>
          <Text style={[styles.roleTitle, { color: theme.text }]}>{text.roleSigningTerminal}</Text>
          <Text style={[styles.roleHint, { color: theme.textSecondary }]}>{text.roleSigningTerminalHint}</Text>
        </Pressable>

        <View style={styles.footerRow}>
          <LanguageSwitch language={language} onChange={onLanguageChange} theme={theme} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function OnboardingView({
  theme,
  mode,
  text,
  language,
  onLanguageChange,
  onCreate,
  onImport
}: {
  theme: typeof dark;
  mode: ThemeMode;
  text: ReturnTypeT;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onCreate: () => void;
  onImport: (mnemonic: string) => void;
}) {
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style={mode === "porcelain" ? "dark" : "light"} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.onboarding}>
          <View style={styles.hero}>
            <View style={styles.logoRow}>
              <Text style={[styles.logoBitcoin, { color: theme.accent }]}>₿</Text>
              <Text style={[styles.logoText, { color: theme.text }]}>{APP_NAME}</Text>
            </View>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{text.tagline}</Text>
            <View style={[styles.visualFrame, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Image source={styleArtwork[mode]} style={styles.visualImage} resizeMode="cover" />
            </View>
          </View>

          <View style={styles.featureList}>
            <SecurityWarningsBanner theme={theme} text={text} />
            <OnboardingFeature icon="01" title={text.nonCustodial} body={text.nonCustodialText} theme={theme} />
            <OnboardingFeature icon="02" title={text.beginner} body={text.beginnerText} theme={theme} />
            <OnboardingFeature icon="03" title={text.walletReady} body={text.riskText} theme={theme} />
          </View>

          <Pressable style={[styles.primaryButton, { backgroundColor: theme.primaryButton }]} onPress={onCreate}>
            <Text style={[styles.primaryButtonText, { color: theme.primaryButtonText }]}>{text.start}</Text>
          </Pressable>

          {!showImport && (
            <Pressable style={[styles.outlineButton, { borderColor: theme.inputBorder }]} onPress={() => setShowImport(true)}>
              <Text style={[styles.outlineButtonText, { color: theme.text }]}>{text.restore}</Text>
            </Pressable>
          )}

          {showImport && (
            <View style={[styles.importPanel, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.panelTitle, { color: theme.text }]}>{text.importTitle}</Text>
              <TextInput
                multiline
                value={importText}
                onChangeText={setImportText}
                placeholder={text.importPlaceholder}
                placeholderTextColor={theme.textMuted}
                style={[styles.seedInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable
                disabled={!importText.trim()}
                style={[styles.secondaryButton, { backgroundColor: importText.trim() ? theme.secondaryButton : theme.surface }]}
                onPress={() => onImport(importText)}
              >
                <Text style={[styles.secondaryButtonText, { color: theme.secondaryButtonText }]}>{text.importAction}</Text>
              </Pressable>
            </View>
          )}

          <View style={styles.footerRow}>
            <LanguageSwitch language={language} onChange={onLanguageChange} theme={theme} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function UnlockView({
  theme,
  mode,
  text,
  onUnlock,
  onBiometricUnlock
}: {
  theme: typeof dark;
  mode: ThemeMode;
  text: ReturnTypeT;
  onUnlock: (pin: string) => Promise<string | null>;
  onBiometricUnlock: () => Promise<boolean>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const bioTried = useRef(false);

  // 生物识别快速解锁：0 次 KDF，只读一次受 Secure Enclave 保护的 DEK 再做
  // 一次 GCM 解密（<100ms）。启用后自动尝试一次，失败静默回退到 PIN 输入。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const enabled = await isBiometricUnlockEnabled().catch(() => false);
      if (cancelled) return;
      setBioAvailable(enabled);
      if (enabled && !bioTried.current) {
        bioTried.current = true;
        await onBiometricUnlock().catch(() => false);
      }
    })();
    return () => { cancelled = true; };
  }, [onBiometricUnlock]);

  async function tryBiometric() {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onBiometricUnlock();
      if (!ok) setError(text.biometricFallbackToPin);
    } finally {
      setBusy(false);
    }
  }

  async function submit(p: string) {
    if (busy) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 60));
    try {
      const err = await onUnlock(p);
      if (err) {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.bg }]}>
      <StatusBar style={mode === "porcelain" ? "dark" : "light"} />
      <View style={styles.unlockWrap}>
        <Text style={[styles.unlockTitle, { color: theme.text }]}>{text.unlockTitle}</Text>
        <Text style={[styles.unlockSubtitle, { color: theme.textSecondary }]}>{text.unlockSubtitle}</Text>
        <PinDialog
          visible
          title={text.unlockTitle}
          subtitle={text.unlockSubtitle}
          errorText={error || undefined}
          cancelLabel=""
          onPinEntered={submit}
          onCancel={() => {}}
          busy={busy}
          busyLabel={text.busyUnlocking}
        />
        {bioAvailable && (
          <Pressable
            onPress={tryBiometric}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={text.biometricUnlockAction}
            style={[styles.bioButton, { borderColor: theme.border }]}
          >
            <Text style={{ color: theme.textSecondary, fontWeight: "700" }}>
              {text.biometricUnlockAction}
            </Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}


class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; theme: typeof dark; mode: ThemeMode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  // Register as global error handler on mount so that async uncaught errors
  // (promise rejections, event-handler throws, timer callbacks) also surface
  // as a visible error screen instead of silently killing the JS thread.
  private _prevHandler: ((error: Error, isFatal?: boolean) => void) | null = null;
  componentDidMount() {
    const ErrorUtils = (globalThis as any).ErrorUtils;
    if (ErrorUtils && typeof ErrorUtils.setGlobalHandler === "function") {
      this._prevHandler = ErrorUtils.getGlobalHandler?.() ?? null;
      const self = this;
      ErrorUtils.setGlobalHandler((error: Error) => {
        logger.warn("Global uncaught error (routed to error boundary)", error);
        self.setState({ error });
        if (self._prevHandler) {
          try {
            self._prevHandler(error);
          } catch {
            /* no-op */
          }
        }
      });
    }
    // Also catch unhandled promise rejections (Hermes has no globalThis.addEventListener,
    // so this is best-effort and never throws).
    if (typeof globalThis !== "undefined" && typeof (globalThis as any).addEventListener === "function") {
      const self = this;
      (globalThis as any).__onUnhandledRejection = function (e: PromiseRejectionEvent) {
        const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason ?? "Unhandled rejection"));
        logger.warn("Global unhandled rejection (routed to error boundary)", err);
        self.setState({ error: err });
        e.preventDefault?.();
      };
      (globalThis as any).addEventListener("unhandledrejection", (globalThis as any).__onUnhandledRejection);
    }
  }

  componentWillUnmount() {
    const ErrorUtils = (globalThis as any).ErrorUtils;
    if (ErrorUtils && typeof ErrorUtils.setGlobalHandler === "function" && this._prevHandler) {
      try {
        ErrorUtils.setGlobalHandler(this._prevHandler);
      } catch {
        /* no-op */
      }
    }
    if (typeof globalThis !== "undefined" && typeof (globalThis as any).removeEventListener === "function" && (globalThis as any).__onUnhandledRejection) {
      (globalThis as any).removeEventListener("unhandledrejection", (globalThis as any).__onUnhandledRejection);
    }
  }

  componentDidCatch(error: Error) {
    logger.warn("Unhandled UI error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { theme, mode } = this.props;
    const err = this.state.error as Error;
    // Surface the real error so crashes are diagnosable on-device instead of
    // showing only a generic message. Safe to show: the device owner is reading
    // their own crash. Truncate the stack so it fits a phone screen.
    const stack = (err.stack || "").split("\n").slice(0, 8).join("\n");
    return (
      <SafeAreaView style={[styles.errorScreen, { backgroundColor: theme.bg }]}>
        <StatusBar style={mode === "porcelain" ? "dark" : "light"} />
        <ScrollView contentContainerStyle={styles.errorScroll}>
          <Text style={[styles.errorTitle, { color: theme.text }]}>{APP_NAME}</Text>
          <Text style={[styles.errorBody, { color: theme.textSecondary }]}>
            The app hit an unexpected error. Please close and reopen SableSat.
          </Text>
          <Text style={[styles.errorDetail, { color: theme.outgoing }]}>{err.name}: {err.message}</Text>
          {!!stack && (
            <Text style={[styles.errorStack, { color: theme.textMuted }]} selectable>{stack}</Text>
          )}
          <Pressable style={[styles.primaryButton, { backgroundColor: theme.primaryButton }]} onPress={() => this.setState({ error: null })}>
            <Text style={[styles.primaryButtonText, { color: theme.primaryButtonText }]}>Retry</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }
}

function LanguageSwitch({
  language,
  onChange,
  theme
}: {
  language: Language;
  onChange: (language: Language) => void;
  theme: typeof dark;
}) {
  return (
    <View style={[styles.languageSwitch, { backgroundColor: theme.surface }]}>
      {(["zh", "en"] as Language[]).map((item) => (
        <Pressable
          key={item}
          onPress={() => onChange(item)}
          style={[styles.languageButton, language === item && { backgroundColor: theme.card }]}
        >
          <Text style={[styles.languageText, { color: language === item ? theme.text : theme.textMuted }]}>
            {item === "zh" ? "中文" : "EN"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function OnboardingFeature({
  icon,
  title,
  body,
  theme
}: {
  icon: string;
  title: string;
  body: string;
  theme: typeof dark;
}) {
  return (
    <View style={styles.featureItem}>
      <View style={[styles.featureIcon, { backgroundColor: theme.surface }]}>
        <Text style={[styles.featureIconText, { color: theme.text }]}>{icon}</Text>
      </View>
      <View style={styles.featureText}>
        <Text style={[styles.featureTitle, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.featureBody, { color: theme.textSecondary }]} numberOfLines={2}>{body}</Text>
      </View>
    </View>
  );
}

function SecurityWarningsBanner({ theme, text }: { theme: typeof dark; text: ReturnTypeT }) {
  // 旧实现在模块顶层就调 getDeviceSecurityState() —— import 期间同步跑
  // jail-monkey 探测 + Device 查询，拖慢 bundle 求值和首屏。getDeviceSecurityState
  // 自身有缓存，放进 useMemo 后开销只在首次渲染这一帧。
  const securityState = React.useMemo(() => getDeviceSecurityState(), []);
  if (securityState.level === "ok") return null;
  const borderColor = securityState.level === "danger" ? theme.outgoing : theme.accent;
  return (
    <View style={[styles.securityBanner, { backgroundColor: theme.surface, borderColor }]}>
      <Text style={[styles.securityBannerTitle, { color: borderColor }]}>{text.securityWarnTitle}</Text>
      {securityState.warnings.map((w) => (
        <Text key={w.code} style={[styles.securityBannerText, { color: theme.textSecondary }]}>
          {"• "}{(text as Record<string, string>)[w.messageKey] ?? w.code}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errorScreen: { flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 16 },
  errorScroll: { padding: 24, paddingBottom: 48, gap: 16, alignItems: "stretch" },
  errorTitle: { fontSize: 28, fontWeight: "900", textAlign: "center" },
  errorBody: { fontSize: 14, lineHeight: 20, textAlign: "center" },
  errorDetail: { fontSize: 13, fontFamily: "monospace", marginTop: 8 },
  errorStack: { fontSize: 10, fontFamily: "monospace", lineHeight: 14, marginTop: 4, opacity: 0.8 },
  onboarding: { padding: 22, paddingTop: 42, paddingBottom: 28, gap: 18, minHeight: "100%" },
  hero: { alignItems: "center", gap: 10 },
  logoRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  logoBitcoin: { fontSize: 31, fontWeight: "900", marginRight: 6 },
  logoText: { fontSize: 34, fontWeight: "900", letterSpacing: 0 },
  subtitle: { fontSize: 15, lineHeight: 22, textAlign: "center", maxWidth: 280 },
  visualFrame: {
    width: "100%",
    maxWidth: 320,
    aspectRatio: 1.55,
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
    marginTop: 8
  },
  visualImage: { width: "100%", height: "100%" },
  featureList: { gap: 16, marginTop: 2 },
  featureItem: { flexDirection: "row", alignItems: "center", gap: 14 },
  featureIcon: { width: 42, height: 42, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  featureIconText: { fontSize: 12, fontWeight: "900" },
  featureText: { flex: 1, minWidth: 0 },
  featureTitle: { fontSize: 14, fontWeight: "900" },
  featureBody: { marginTop: 3, fontSize: 12, lineHeight: 17 },
  primaryButton: {
    minHeight: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18
  },
  primaryButtonText: { fontSize: 16, fontWeight: "900" },
  outlineButton: {
    minHeight: 48,
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18
  },
  outlineButtonText: { fontSize: 15, fontWeight: "900" },
  importPanel: { padding: 16, gap: 12, borderRadius: 8, borderWidth: 1 },
  panelTitle: { fontSize: 20, fontWeight: "900" },
  seedInput: {
    minHeight: 104,
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
    textAlignVertical: "top",
    fontSize: 15,
    lineHeight: 21
  },
  secondaryButton: {
    minHeight: 50,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16
  },
  secondaryButtonText: { fontSize: 15, fontWeight: "900" },
  languageSwitch: {
    flexDirection: "row",
    padding: 4,
    borderRadius: 8,
    alignSelf: "center"
  },
  languageButton: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  languageText: { fontWeight: "800" },
  footerRow: { alignItems: "center" },
  bioButton: {
    marginTop: 20,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  unlockWrap: { flex: 1, justifyContent: "center", padding: 24 },
  unlockTitle: { fontSize: 22, fontWeight: "900", textAlign: "center", marginBottom: 8 },
  unlockSubtitle: { fontSize: 13, lineHeight: 18, textAlign: "center", marginBottom: 24, color: "#9CA3AF" },
  securityBanner: { borderRadius: 8, borderWidth: 1, padding: 12, gap: 6 },
  securityBannerTitle: { fontSize: 13, fontWeight: "900" },
  securityBannerText: { fontSize: 12, lineHeight: 17 },
  roleSelectHint: { fontSize: 13, lineHeight: 18, textAlign: "center", maxWidth: 300, marginTop: 6 },
  roleCard: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 4 },
  roleTitle: { fontSize: 16, fontWeight: "900" },
  roleHint: { fontSize: 12, lineHeight: 17 },
  // BIP39 passphrase modal
  passphraseOverlay: { flex: 1, justifyContent: "center", backgroundColor: "rgba(0,0,0,0.6)", padding: 24 },
  passphraseCard: { borderRadius: 12, borderWidth: 1, padding: 20, gap: 12 },
  passphraseTitle: { fontSize: 18, fontWeight: "900", textAlign: "center" },
  passphraseHint: { fontSize: 13, lineHeight: 18, textAlign: "center", marginBottom: 4 },
  passphraseInput: { minHeight: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 15, fontWeight: "600" },
  passphraseError: { fontSize: 12, fontWeight: "800", textAlign: "center" },
  passphraseActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  passphraseSkipBtn: { flex: 1, minHeight: 44, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  passphraseSkipText: { fontSize: 14, fontWeight: "800" },
  passphraseConfirmBtn: { flex: 1, minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  passphraseConfirmText: { fontSize: 14, fontWeight: "800" },
});
