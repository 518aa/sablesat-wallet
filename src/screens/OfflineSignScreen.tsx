import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { PsbtQr } from "../components/PsbtQr";
import { PinDialog } from "../components/PinDialog";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import { authenticate, getAvailableAuthMethod, verifyPin } from "../services/auth";
import { reviewPsbt, signPsbtOffline, hasUnknownOutput } from "../services/transaction";
import { isNetworkReachable, validatePsbtFingerprints, validatePsbtForSigning } from "../services/offline";
import { readSigningTerminalConfig } from "../services/deviceRole";
import { getAccountZpub, getMnemonicForExport, getPrivateKey, isDuress, type Wallet } from "../services/wallet";
import { assertExportAllowed, SecurityPolicyError } from "../services/security";
import { useScreenGuard } from "../services/screenGuard";
import { satsToBtc } from "../utils/bitcoin";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Stage = "home" | "scan" | "review" | "signed";

type Props = {
  text: ReturnTypeT;
  wallet: Wallet;
  onBack: () => void;
};

// 离线签名终端主屏。按操作逻辑分三步引导：① 冷钱包就绪(显示地址)
// ② 导出 zpub 给在线设备 ③ 扫码签名。签名子流程：扫未签 PSBT → 完整性校验 →
// 飞行模式软警告 → 二次验证 → signPsbtOffline → QR 输出已签 PSBT。全程不联网。
export function OfflineSignScreen({ text, wallet, onBack }: Props) {
  // 助记词 / 私钥 / PSBT 均为敏感内容：挂载期间禁止截屏与录屏，
  // 同时避免进入 Android 最近任务缩略图与 iOS App Switcher 快照。
  useScreenGuard("offline-sign");
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [stage, setStage] = useState<Stage>("home");
  const [psbtInput, setPsbtInput] = useState<string | null>(null);
  const [signedPsbt, setSignedPsbt] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinPurpose, setPinPurpose] = useState<"sign" | "mnemonic">("sign");
  const [pinError, setPinError] = useState("");
  const [zpubCopied, setZpubCopied] = useState(false);
  const [showMnemonic, setShowMnemonic] = useState(false);
  const [mnemonicText, setMnemonicText] = useState<string | null>(null);
  const [showPrivKey, setShowPrivKey] = useState(false);
  const [privKeyHex, setPrivKeyHex] = useState<string | null>(null);

  // 账户级 zpub（m/84'/0'/0'）。钱包已解锁才能取；失败降级为空串不崩。
  const zpub = useMemo(() => {
    try {
      return getAccountZpub();
    } catch (e) {
      logger.warn("getAccountZpub failed", e);
      return "";
    }
  }, []);

  // 待签 PSBT 的人可读摘要（输出地址/金额/手续费），供签名前核对，防盲签。
  const review = useMemo(() => {
    if (!psbtInput) return null;
    try {
      return reviewPsbt(psbtInput);
    } catch (e) {
      logger.warn("reviewPsbt failed", e);
      return null;
    }
  }, [psbtInput]);

  async function copyAddress() {
    if (!wallet.address) return;
    await Clipboard.setStringAsync(wallet.address);
    Alert.alert(text.appName, text.copied);
  }

  async function copyZpub() {
    if (!zpub) return;
    await Clipboard.setStringAsync(zpub);
    setZpubCopied(true);
    Alert.alert(text.appName, text.signTerminalZpubCopied);
  }

  function handleScanned(data: string) {
    setShowScanner(false);
    const trimmed = data.trim();
    const code = validatePsbtForSigning(trimmed);
    if (code) {
      setError(text.signTerminalInvalidPsbt);
      return;
    }
    setError(null);
    setPsbtInput(trimmed);
    setStage("review");
  }

  async function handleSign() {
    setError(null);
    const reachable = await isNetworkReachable();
    if (reachable) {
      Alert.alert(text.signTerminalNetworkWarn, text.signTerminalNetworkBody, [
        { text: text.signTerminalNetworkCancel, style: "cancel" },
        { text: text.signTerminalNetworkContinue, onPress: () => void proceedAuth() },
      ]);
      return;
    }
    await proceedAuth();
  }

  async function proceedAuth() {
    const method = await getAvailableAuthMethod();
    if (method === "biometric") {
      const ok = await authenticate(text.biometricPrompt);
      if (!ok) return;
      await doSign();
    } else if (method === "pin") {
      setPinPurpose("sign");
      setPinError("");
      setShowPinDialog(true);
    } else {
      setError(text.biometricFallback);
    }
  }

  async function handlePinSubmit(pin: string) {
    const ok = await verifyPin(pin);
    if (!ok) {
      setPinError(text.pinVerifyError);
      return;
    }
    setShowPinDialog(false);
    if (pinPurpose === "mnemonic") {
      try {
        setMnemonicText(await getMnemonicForExport(pin));
        setShowMnemonic(true);
      } catch (e) {
        logger.warn("Failed to export mnemonic", e);
      }
    } else {
      await doSign();
    }
  }

  async function doSign() {
    if (!psbtInput) return;
    setBusy(true);
    setError(null);
    try {
      // S-1 防御：任一输出脚本未能反解为已知地址（sentinel "?"）→ 阻断签名，
      // 防非标脚本攻击（攻击者构造 reviewPsbt 无法显示地址的输出，让用户盲签）。
      const summary = reviewPsbt(psbtInput);
      if (hasUnknownOutput(summary)) {
        setError(text.signTerminalInvalidPsbt);
        return;
      }
      // 签名终端指纹白名单：非空白名单时，PSBT 中所有 master fingerprint
      // 必须在白名单内，拒绝未授权来源的签名请求。
      const cfg = await readSigningTerminalConfig();
      if (cfg && cfg.linkedFingerprints.length > 0) {
        const result = validatePsbtFingerprints(psbtInput, cfg.linkedFingerprints);
        if (!result.ok) {
          setError(text.signTerminalFingerprintRejected?.replace("{fp}", result.rejected.join(", ")) || `Rejected fingerprints: ${result.rejected.join(", ")}`);
          return;
        }
      }
      const signed = await signPsbtOffline(psbtInput);
      setSignedPsbt(signed);
      setStage("signed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/mismatch|tamper|outside/i.test(msg) ? text.signTerminalInvalidPsbt : msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopySigned() {
    if (!signedPsbt) return;
    await Clipboard.setStringAsync(signedPsbt);
    Alert.alert(text.appName, text.copied);
  }

  function resetToHome() {
    setStage("home");
    setPsbtInput(null);
    setSignedPsbt(null);
    setError(null);
  }

  function revealMnemonic() {
    if (isDuress()) return;
    Alert.alert(text.signTerminalExportMnemonic, text.backupWarning, [
      { text: text.cancel, style: "cancel" },
      {
        text: text.reveal, style: "destructive", onPress: () => {
          // 导出助记词必须 PIN：getMnemonicForExport 需 PIN 解密 SecureStore
          setPinPurpose("mnemonic");
          setPinError("");
          setShowPinDialog(true);
        }
      },
    ]);
  }
  function hideMnemonic() { setMnemonicText(null); setShowMnemonic(false); }

  function revealPrivKey() {
    if (isDuress()) return;
    Alert.alert(text.signTerminalExportPrivateKey, text.signTerminalPrivKeyWarn, [
      { text: text.cancel, style: "cancel" },
      {
        text: text.signTerminalRevealPriv, style: "destructive", onPress: async () => {
          try {
            assertExportAllowed();
            const pk = await getPrivateKey();
            const hex = Array.from(pk).map((b) => b.toString(16).padStart(2, "0")).join("");
            setPrivKeyHex(hex);
            setShowPrivKey(true);
            // 30 秒自动隐藏（与助记词保持一致），降低私钥暴露窗口
            setTimeout(() => { setPrivKeyHex(null); setShowPrivKey(false); }, 30_000);
          } catch (e) {
            if (e instanceof SecurityPolicyError) {
              Alert.alert(text.appName, text.securityExportBlocked);
            } else {
              logger.warn("Failed to get private key", e);
            }
          }
        }
      },
    ]);
  }
  function hidePrivKey() { setPrivKeyHex(null); setShowPrivKey(false); }
  // 助记词与私钥**不提供**剪贴板复制。
  //
  // Android 上任意 App 可读剪贴板，iOS 通用剪贴板会同步到同一 Apple ID 的其他
  // 设备——30 秒的自动清空窗口远不足以防住这两条路径。这是钱包领域公认的反模式，
  // 因此改为「屏幕显示 + 手抄 + 逐词校验」。

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {showScanner && (
        <QrScanner
          mode="psbt"
          progressLabel={text.psbtScanProgress}
          onScanned={handleScanned}
          onClose={() => setShowScanner(false)}
          closeLabel={text.cancel}
          deniedTitle={text.vaultCosignCameraDeniedTitle}
          deniedBody={text.vaultCosignCameraDeniedBody}
          authorizeLabel={text.cameraAuthorize}
          scanHint={text.scanHint}
        />
      )}
      <View style={[styles.header, { marginTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.signTerminalExit} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{text.signTerminalExit}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{text.signTerminalHomeTitle}</Text>
        <View style={{ width: 64 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {stage === "home" && (
          <>
            {/* ① 冷钱包就绪 */}
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.stepBadge, { color: theme.accent }]}>①</Text>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{text.signTerminalIntroTitle}</Text>
              <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.signTerminalIntroBody}</Text>
              <Text style={[styles.label, { color: theme.textSecondary }]}>{text.signTerminalAddressTitle}</Text>
              <Pressable onPress={copyAddress} accessibilityRole="button" accessibilityLabel={text.signTerminalCopyAddress} hitSlop={8} style={[styles.addressBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}>
                <Text style={[styles.address, { color: theme.text }]} selectable>{wallet.address}</Text>
                <Text style={[styles.copyMini, { color: theme.textMuted }]}>{text.signTerminalCopyAddress}</Text>
              </Pressable>
              <Text style={[styles.tip, { color: theme.textMuted }]}>{text.signTerminalAddressHint}</Text>
              <View style={[styles.noticeBox, { borderColor: theme.border, backgroundColor: theme.input }]}>
                <Text style={[styles.notice, { color: theme.textSecondary }]}>{text.signTerminalBalanceNotice}</Text>
              </View>
            </View>

            {/* ② 导出 zpub */}
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.stepBadge, { color: theme.accent }]}>②</Text>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{text.signTerminalZpubTitle}</Text>
              {zpub ? (
                <View style={styles.qrWrap}><QrCode value={zpub} size={200} /></View>
              ) : (
                <Text style={[styles.error, { color: theme.outgoing }]}>{text.walletLocked}</Text>
              )}
              <Pressable onPress={copyZpub} accessibilityRole="button" accessibilityLabel={text.copy} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface, alignSelf: "flex-start" }]}>
                <Text style={[styles.smallBtnText, { color: theme.text }]}>{zpubCopied ? text.copied : text.copy}</Text>
              </Pressable>
              <Text style={[styles.tip, { color: theme.textMuted }]}>{text.signTerminalZpubBody}</Text>
            </View>

            {/* ③ 签署交易 */}
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.stepBadge, { color: theme.accent }]}>③</Text>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{text.signTerminalSignTitle}</Text>
              <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.signTerminalSignBody}</Text>
              <Pressable
                onPress={() => { setError(null); setShowScanner(true); }}
                accessibilityRole="button"
                accessibilityLabel={text.signTerminalStartSign}
                style={[styles.submitBtn, { backgroundColor: theme.primaryButton }]}
              >
                <Text style={[styles.submitBtnText, { color: theme.primaryButtonText }]}>{text.signTerminalStartSign}</Text>
              </Pressable>
              <Text style={[styles.tip, { color: theme.warning }]}>{text.signTerminalLockGuide}</Text>
              {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
            </View>

            {/* 导出助记词 */}
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{text.signTerminalExportMnemonic}</Text>
              <Text style={[styles.hint, { color: theme.outgoing }]}>{text.mnemonicNoScreenshot}</Text>
              {showMnemonic && mnemonicText ? (
                <>
                  <Text style={[styles.secretBox, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]} selectable>{mnemonicText}</Text>
                  <View style={styles.rowBtns}>
                    <Pressable onPress={hideMnemonic} accessibilityRole="button" accessibilityLabel={text.hide} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface }]}><Text style={[styles.smallBtnText, { color: theme.text }]}>{text.hide}</Text></Pressable>
                  </View>
                </>
              ) : (
                <Pressable onPress={revealMnemonic} accessibilityRole="button" accessibilityLabel={text.reveal} style={[styles.submitBtn, { backgroundColor: theme.outgoing }]}>
                  <Text style={[styles.submitBtnText, { color: "#fff" }]}>{text.reveal}</Text>
                </Pressable>
              )}
            </View>

            {/* 导出私钥 */}
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{text.signTerminalExportPrivateKey}</Text>
              <Text style={[styles.hint, { color: theme.outgoing }]}>{text.signTerminalPrivKeyWarn}</Text>
              {showPrivKey && privKeyHex ? (
                <>
                  <Text style={[styles.secretBox, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]} selectable>{privKeyHex}</Text>
                  <View style={styles.rowBtns}>
                    <Pressable onPress={hidePrivKey} accessibilityRole="button" accessibilityLabel={text.hide} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface }]}><Text style={[styles.smallBtnText, { color: theme.text }]}>{text.hide}</Text></Pressable>
                  </View>
                </>
              ) : (
                <Pressable onPress={revealPrivKey} accessibilityRole="button" accessibilityLabel={text.signTerminalRevealPriv} style={[styles.submitBtn, { backgroundColor: theme.outgoing }]}>
                  <Text style={[styles.submitBtnText, { color: "#fff" }]}>{text.signTerminalRevealPriv}</Text>
                </Pressable>
              )}
            </View>
          </>
        )}

        {stage === "review" && psbtInput && (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.warning }]}>{text.vaultCosignReviewWarn}</Text>
            {review && (
              <View style={[styles.reviewBox, { borderColor: theme.border }]}>
                <Text style={[styles.reviewLabel, { color: theme.textSecondary }]}>{text.sendingTo}</Text>
                {review.outputs.map((o, i) => (
                  <View key={i} style={styles.reviewRow}>
                    <Text style={[styles.reviewAddr, { color: theme.text }]} numberOfLines={1}>{o.address || "(unknown)"}</Text>
                    <Text style={[styles.reviewAmt, { color: theme.text }]}>{satsToBtc(o.sats)}</Text>
                  </View>
                ))}
                <View style={[styles.reviewRow, { borderTopWidth: 1, borderTopColor: theme.border, marginTop: 6, paddingTop: 6 }]}>
                  <Text style={[styles.reviewLabel, { color: theme.textSecondary }]}>{text.networkFee}</Text>
                  <Text style={[styles.reviewAmt, { color: theme.textSecondary }]}>{review.feeSats} sats</Text>
                </View>
              </View>
            )}
            <Text style={[styles.psbtPreview, { color: theme.textMuted }]} numberOfLines={4}>{psbtInput}</Text>
            <Pressable disabled={busy} onPress={handleSign} accessibilityRole="button" accessibilityLabel={text.signTerminalSignAndExport} style={[styles.submitBtn, { backgroundColor: busy ? theme.surface : theme.primaryButton }]}>
              <Text style={[styles.submitBtnText, { color: busy ? theme.textMuted : theme.primaryButtonText }]}>
                {busy ? text.loading : text.signTerminalSignAndExport}
              </Text>
            </Pressable>
            <Pressable onPress={resetToHome} accessibilityRole="button" accessibilityLabel={text.cancel} style={styles.linkBtn}>
              <Text style={[styles.linkText, { color: theme.accent }]}>{text.cancel}</Text>
            </Pressable>
            {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
          </View>
        )}

        {stage === "signed" && signedPsbt && (
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.incoming }]}>{text.signTerminalSignedHint}</Text>
            {/* 超容量自动切 BC-UR 动态轮播。气隙设备上 QR 是唯一通道，
                旧实现在这里只有一句"太长了"，等于把已签 PSBT 锁死在本机。 */}
            <PsbtQr
              psbtB64={signedPsbt}
              size={240}
              animatedHint={text.psbtAnimatedHint}
              unavailableHint={text.psbtUrUnavailable}
            />
            <Pressable onPress={handleCopySigned} accessibilityRole="button" accessibilityLabel={text.copy} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface, alignSelf: "flex-start" }]}>
              <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.copy}</Text>
            </Pressable>
            <Pressable onPress={resetToHome} accessibilityRole="button" accessibilityLabel={text.back} style={[styles.submitBtn, { backgroundColor: theme.primaryButton }]}>
              <Text style={[styles.submitBtnText, { color: theme.primaryButtonText }]}>{text.back}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <PinDialog
        visible={showPinDialog}
        title={text.pinVerifyTitle}
        subtitle={text.pinVerifySubtitle}
        errorText={pinError || undefined}
        cancelLabel={text.cancel}
        onPinEntered={handlePinSubmit}
        onCancel={() => {
          setShowPinDialog(false);
          setPinError("");
        }}
      />
      <LoadingOverlay visible={busy} label={text.busySignTerminalSigning} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 10 },
  stepBadge: { fontSize: 18, fontWeight: "900" },
  cardTitle: { fontSize: 15, fontWeight: "900" },
  hint: { fontSize: 12, lineHeight: 18 },
  tip: { fontSize: 11, lineHeight: 16 },
  label: { fontSize: 12, fontWeight: "900", marginTop: 4 },
  addressBox: { borderWidth: 1, borderRadius: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  address: { flex: 1, fontSize: 11, fontFamily: "monospace" },
  copyMini: { fontSize: 10, fontWeight: "900" },
  qrWrap: { alignItems: "center", paddingVertical: 4 },
  smallBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6 },
  smallBtnText: { fontSize: 11, fontWeight: "900" },
  submitBtn: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 14, fontWeight: "900" },
  linkBtn: { alignItems: "center", paddingVertical: 8 },
  linkText: { fontSize: 12, fontWeight: "900" },
  error: { fontSize: 12 },
  psbtPreview: { fontSize: 10, fontFamily: "monospace" },
  reviewBox: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 4 },
  reviewLabel: { fontSize: 11, fontWeight: "900" },
  reviewRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  reviewAddr: { flex: 1, fontSize: 11, fontFamily: "monospace" },
  reviewAmt: { fontSize: 12, fontWeight: "900", fontFamily: "monospace" },
  noticeBox: { borderWidth: 1, borderRadius: 8, padding: 12, marginTop: 4 },
  notice: { fontSize: 11, lineHeight: 17 },
  secretBox: { fontSize: 12, fontFamily: "monospace", borderWidth: 1, borderRadius: 8, padding: 12, lineHeight: 18 },
  rowBtns: { flexDirection: "row", gap: 10 },
});
