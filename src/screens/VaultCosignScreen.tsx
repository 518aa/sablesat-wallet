import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { PsbtSummary } from "../components/PsbtSummary";
import { QrScanner } from "../components/QrScanner";
import { PsbtQr } from "../components/PsbtQr";
import { PinDialog } from "../components/PinDialog";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import { authenticate, getAvailableAuthMethod, verifyPin } from "../services/auth";
import { useVaults } from "../hooks/useVaults";
import { combineVaultPsbt, inputsFromPsbt, matchVaultForPsbt, signVaultPsbtSelf, summarizePsbt } from "../services/vault/psbt";
import { reviewPsbt, hasUnknownOutput, broadcastSignedPsbt } from "../services/transaction";
import { isWalletUnlocked, getRootUnlocked } from "../services/wallet";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  text: ReturnTypeT;
  onBack: () => void;
  onDone: () => void;
};

type Stage = "input" | "review" | "signed" | "broadcast";

export function VaultCosignScreen({ text, onBack, onDone }: Props) {
  const { theme } = useTheme();
  const { vaults } = useVaults();
  const [psbtInput, setPsbtInput] = useState("");
  const [vaultId, setVaultId] = useState<string | null>(null);
  const [currentPsbt, setCurrentPsbt] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("input");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showCombineScanner, setShowCombineScanner] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinError, setPinError] = useState("");

  const vault = useMemo(() => vaults.find((v) => v.id === vaultId) ?? null, [vaults, vaultId]);

  /**
   * 本机在这笔 PSBT 里的输入（含派生索引）。
   *
   * 【为什么必须算出来】旧实现给 summarizePsbt 传的是空数组，两个后果：
   *   1. 摘要里每个输入的 address 都是空串——用户核对不了自己在签什么；
   *   2. signScanUpperBound([]) 恒等于 20，找零索引一旦超过 20 就被判成"外部
   *      输出"，assertSignable 直接拒签。金库用久了会突然签不动。
   */
  const knownInputs = useMemo(() => {
    if (!currentPsbt || !vault) return [];
    const self = vault.cosigners.find((c) => c.role === "self");
    if (!self) return [];
    try {
      return inputsFromPsbt(currentPsbt, self.xpub);
    } catch {
      return [];
    }
  }, [currentPsbt, vault]);

  const parsedSummary = useMemo(() => {
    if (!currentPsbt || !vault) return null;
    try {
      return summarizePsbt(currentPsbt, vault, knownInputs);
    } catch {
      return null;
    }
  }, [currentPsbt, vault, knownInputs]);

  async function handlePaste() {
    const clip = await Clipboard.getStringAsync();
    if (clip) setPsbtInput(clip.trim());
  }

  function handleScanned(data: string) {
    setShowScanner(false);
    setPsbtInput(data);
  }

  function handleLoadPsbt() {
    setError(null);
    setTxid(null);
    const trimmed = psbtInput.trim();
    if (!trimmed) return;
    // 按 witnessUtxo.script 与本金库派生结果的字节相等来匹配（见 matchVaultForPsbt）。
    // 旧实现拿 summarizePsbt 会不会抛错当判据，而它对错误的金库根本不抛 ——
    // 多金库时必然选中列表里的第一个。
    const match = matchVaultForPsbt(trimmed, vaults);
    if (!match) {
      setError(text.vaultCosignPsbtUnmatched);
      return;
    }
    setVaultId(match.id);
    setCurrentPsbt(trimmed);
    setStage("review");
  }

  async function handleSign() {
    if (!vault || !currentPsbt) return;
    setError(null);
    const method = await getAvailableAuthMethod();
    if (method === "biometric") {
      const authorized = await authenticate(text.biometricPrompt);
      if (!authorized) return;
      await doSign();
    } else if (method === "pin") {
      setPinError("");
      setShowPinDialog(true);
    } else {
      setError(text.biometricFallback);
    }
  }

  async function handlePinSubmit(pin: string) {
    const valid = await verifyPin(pin);
    if (!valid) {
      setPinError(text.pinVerifyError);
      return;
    }
    setShowPinDialog(false);
    await doSign();
  }

  async function doSign() {
    if (!vault || !currentPsbt) return;
    setBusy(true);
    setError(null);
    try {
      if (!isWalletUnlocked()) throw new Error("Wallet locked");
      const selfCosigner = vault.cosigners.find((c) => c.role === "self");
      if (!selfCosigner) throw new Error("Vault has no self cosigner");
      // S-1 防御：未识别输出地址 → 阻断签名（与 OfflineSignScreen 对齐）
      const summary = reviewPsbt(currentPsbt);
      if (hasUnknownOutput(summary)) {
        setError(text.vaultCosignTampered);
        return;
      }
      const inputs = inputsFromPsbt(currentPsbt, selfCosigner.xpub);
      const signed = signVaultPsbtSelf(currentPsbt, vault, inputs, getRootUnlocked());
      setCurrentPsbt(signed);
      setStage("signed");
    } catch (err) {
      logger.warn("Cosign failed", err);
      const msg = err instanceof Error ? err.message : "Signing failed";
      setError(/mismatch|tamper|does not match/i.test(msg) ? text.vaultCosignTampered : msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleCombineAndBroadcast() {
    if (!vault || !currentPsbt) return;
    setBusy(true);
    setError(null);
    try {
      // 【旧实现：金库交易在国内基本广播不出去】这里直连 mempool.space /
      // blockstream POST /tx —— 恰恰是项目自己在 blockchainInfo.ts 里注明
      // "国内被 400 拒" 的那条路径。热钱包早就改走东京反代 blockchain.info 了，
      // 金库这条链路被漏掉，仍在打不通的节点上。
      //
      // 而且它复制了同一段坏逻辑：fetchBitcoinApi 在非 2xx 时根本不返回
      // response（自己抛 `Network unavailable: 400`），下面读 errText 的分支
      // 是死代码，节点给的真实拒绝理由全部丢失。
      //
      // 现在复用 broadcastSignedPsbt：主路径反代 + 兜底节点 + 保留拒绝理由 +
      // "已在 mempool" 判为成功 + 本地 txid 比对。单签多签共用同一条广播链路。
      const { txid: newTxid } = await broadcastSignedPsbt(currentPsbt);
      setTxid(newTxid);
      setStage("broadcast");
    } catch (err) {
      logger.warn("Broadcast failed", err);
      setError(err instanceof Error ? err.message : "Broadcast failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyPsbt() {
    if (!currentPsbt) return;
    await Clipboard.setStringAsync(currentPsbt);
    Alert.alert(text.appName, text.copied);
  }

  function handleCombineScanned(data: string) {
    setShowCombineScanner(false);
    if (!currentPsbt || !vault) return;
    try {
      const combined = combineVaultPsbt(currentPsbt, data);
      setCurrentPsbt(combined);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Combine failed");
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
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
        {showCombineScanner && (
          <QrScanner
            mode="psbt"
            progressLabel={text.psbtScanProgress}
            onScanned={handleCombineScanned}
            onClose={() => setShowCombineScanner(false)}
            closeLabel={text.cancel}
            deniedTitle={text.vaultCosignCameraDeniedTitle}
            deniedBody={text.vaultCosignCameraDeniedBody}
            authorizeLabel={text.cameraAuthorize}
            scanHint={text.scanHint}
          />
        )}
        <View style={styles.header}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.vaultBackToList} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.vaultBackToList}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.vaultDetailCosign}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {stage === "input" && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultDetailCosign}</Text>
              <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>
                {text.vaultCosignPasteHint}
              </Text>
              <View style={[styles.textInputRow, { borderColor: theme.inputBorder, backgroundColor: theme.input }]}>
                <TextInput
                  value={psbtInput}
                  onChangeText={setPsbtInput}
                  placeholder="cHNidP8BA..."
                  placeholderTextColor={theme.textMuted}
                  style={[styles.textInput, { color: theme.text }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <Pressable onPress={() => setShowScanner(true)} accessibilityRole="button" accessibilityLabel={text.vaultCosignScan} hitSlop={8} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.vaultCosignScan}</Text>
                </Pressable>
                <Pressable onPress={handlePaste} accessibilityRole="button" accessibilityLabel={text.paste} hitSlop={8} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.paste}</Text>
                </Pressable>
              </View>
              <Pressable
                disabled={!psbtInput.trim()}
                onPress={handleLoadPsbt}
                accessibilityRole="button"
                accessibilityLabel={text.confirmSend}
                style={[styles.submitBtn, { backgroundColor: psbtInput.trim() ? theme.primaryButton : theme.surface }]}
              >
                <Text style={[styles.submitBtnText, { color: psbtInput.trim() ? theme.primaryButtonText : theme.textMuted }]}>
                  {text.confirmSend}
                </Text>
              </Pressable>
              {error && <Text style={[styles.errorText, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "review" && vault && currentPsbt && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.sectionHint, { color: theme.warning }]}>
                {text.vaultCosignReviewWarn}
              </Text>
              <PsbtSummary psbtB64={currentPsbt} vault={vault} knownInputs={knownInputs} signaturesNeeded={vault.m} text={text} />
              <Pressable
                disabled={busy}
                onPress={handleSign}
                accessibilityRole="button"
                accessibilityLabel={text.confirmSend}
                style={[styles.submitBtn, { backgroundColor: busy ? theme.surface : theme.primaryButton }]}
              >
                <Text style={[styles.submitBtnText, { color: busy ? theme.textMuted : theme.primaryButtonText }]}>
                  {busy ? text.loading : text.confirmSend}
                </Text>
              </Pressable>
              {error && <Text style={[styles.errorText, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "signed" && vault && currentPsbt && parsedSummary && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <PsbtSummary psbtB64={currentPsbt} vault={vault} knownInputs={knownInputs} signaturesNeeded={vault.m} text={text} />

              {parsedSummary.readyToFinalize ? (
                <Pressable
                  disabled={busy}
                  onPress={handleCombineAndBroadcast}
                  accessibilityRole="button"
                  accessibilityLabel={text.vaultCosignBroadcast}
                  style={[styles.submitBtn, { backgroundColor: busy ? theme.surface : theme.incoming }]}
                >
                  <Text style={[styles.submitBtnText, { color: busy ? theme.textMuted : theme.primaryButtonText }]}>
                    {busy ? text.sending : text.vaultCosignBroadcast}
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.qrWrap}>
                  <PsbtQr
                    psbtB64={currentPsbt}
                    size={240}
                    hint={text.vaultCosignSignedHint.replace("{m}", String(vault.m))}
                    animatedHint={text.psbtAnimatedHint}
                    unavailableHint={text.psbtUrUnavailable}
                  />
                  <Text style={[styles.psbtText, { color: theme.textMuted }]} numberOfLines={3} ellipsizeMode="tail">
                    {currentPsbt}
                  </Text>
                  <Pressable onPress={handleCopyPsbt} accessibilityRole="button" accessibilityLabel={text.copy} hitSlop={8} style={[styles.copyBtn, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.copyBtnText, { color: theme.text }]}>{text.copy}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowCombineScanner(true)}
                    accessibilityRole="button"
                    accessibilityLabel={text.vaultCosignCombine}
                    style={[styles.submitBtn, { backgroundColor: theme.surface, marginTop: 8 }]}
                  >
                    <Text style={[styles.submitBtnText, { color: theme.text }]}>{text.vaultCosignCombine}</Text>
                  </Pressable>
                </View>
              )}
              {error && <Text style={[styles.errorText, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "broadcast" && txid && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.incoming }]}>{text.sendSuccess}</Text>
              <Text style={[styles.txidLabel, { color: theme.textSecondary }]}>txid</Text>
              <Text style={[styles.txidValue, { color: theme.text }]} selectable>{txid}</Text>
              <Pressable onPress={onDone} accessibilityRole="button" accessibilityLabel={text.backToWallet} style={[styles.submitBtn, { backgroundColor: theme.primaryButton }]}>
                <Text style={[styles.submitBtnText, { color: theme.primaryButtonText }]}>{text.backToWallet}</Text>
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

        <LoadingOverlay visible={busy} label={text.busySigning} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12 },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 0.4 },
  sectionHint: { fontSize: 12, lineHeight: 17 },
  textInputRow: { flexDirection: "row", borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, gap: 6, alignItems: "flex-end" },
  textInput: { flex: 1, minHeight: 88, fontSize: 11, fontFamily: "monospace", padding: 4 },
  pasteBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  pasteBtnText: { fontSize: 11, fontWeight: "900" },
  submitBtn: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 14, fontWeight: "900" },
  errorText: { fontSize: 12 },
  qrWrap: { alignItems: "center", gap: 10 },
  qrHint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  tooLongCard: { paddingVertical: 16, paddingHorizontal: 12, alignItems: "center" },
  tooLongTitle: { fontSize: 12, fontWeight: "900", textAlign: "center", lineHeight: 18 },
  psbtText: { fontSize: 10, fontFamily: "monospace" },
  copyBtn: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8 },
  copyBtnText: { fontSize: 11, fontWeight: "900" },
  txidLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  txidValue: { fontSize: 12, fontFamily: "monospace" },
});
