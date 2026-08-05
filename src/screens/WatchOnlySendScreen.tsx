import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { QrScanner } from "../components/QrScanner";
import { PsbtQr } from "../components/PsbtQr";
import { FeeSelector, type FeeTier } from "../components/FeeSelector";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import { buildWatchPsbt, commitWatchChangeIdx, deriveWatchAddresses, fetchWatchBalanceSats } from "../services/watchOnly";
import {
  assertSamePsbtTransaction,
  broadcastSignedPsbt,
  reviewPsbt,
  signedInputCount,
} from "../services/transaction";
import { PsbtMismatchError } from "../services/psbtCommon";
import { GAP_LIMIT } from "../services/wallet";
import { fetchFeeEstimates } from "../services/blockchain";
import { validateBtcAddress, btcToSatsOrNull, satsToBtc } from "../utils/bitcoin";
import type { WatchOnlyConfig } from "../services/deviceRole";
import type { ReturnTypeT } from "../i18n";

type Stage = "form" | "unsigned" | "confirm" | "done";

type Props = {
  text: ReturnTypeT;
  watchOnly: WatchOnlyConfig;
  onBack: () => void;
};

export function WatchOnlySendScreen({ text, watchOnly, onBack }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feeTier, setFeeTier] = useState<FeeTier>("medium");
  const [fees, setFees] = useState({ slow: 2, medium: 5, fast: 20 });
  const [balance, setBalance] = useState(0);
  const [busyAction, setBusyAction] = useState<"build" | "broadcast" | null>(null);
  const [stage, setStage] = useState<Stage>("form");
  const [unsignedPsbt, setUnsignedPsbt] = useState<string | null>(null);
  const [builtInfo, setBuiltInfo] = useState<{ feeSats: number; inputCount: number; changeIdx: number } | null>(null);
  const [signedPsbt, setSignedPsbt] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<"none" | "recipient" | "signed">("none");
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = busyAction !== null;

  useEffect(() => {
    fetchFeeEstimates().then(setFees).catch(() => {});
    fetchWatchBalanceSats(watchOnly.zpub).then(setBalance).catch(() => {});
  }, [watchOnly.zpub]);

  // btcToSatsOrNull 对非法输入返回 null（旧实现静默返回 0，UI 无法区分
  // 「无效输入」与「零金额」）。这里统一收敛为 0 用于比较，实际发送前会再校验。
  const amountSatsRaw = useMemo(() => btcToSatsOrNull(amount), [amount]);
  const amountSats = amountSatsRaw ?? 0;
  const amountInvalid = amount.trim() !== "" && amountSatsRaw === null;
  const canBuild = validateBtcAddress(recipient.trim()) && amountSats > 0 && amountSats <= balance && !busy;

  // 本观察钱包自己的地址集合（receive + change，覆盖扫描窗口）。
  // 用来在确认页把「找零」和「真正的收款方」区分开 —— 否则用户会看到两个输出、
  // 两个金额，无从判断哪个是发给对方的。
  const ownAddresses = useMemo(() => {
    try {
      return new Set([
        ...deriveWatchAddresses(watchOnly.zpub, GAP_LIMIT + 1, false),
        ...deriveWatchAddresses(watchOnly.zpub, GAP_LIMIT + 1, true),
      ]);
    } catch {
      return new Set<string>();
    }
  }, [watchOnly.zpub]);

  // 确认页的数据源：**扫回来的已签 PSBT 本身**。
  const signedReview = useMemo(() => {
    if (!signedPsbt) return null;
    try {
      const r = reviewPsbt(signedPsbt);
      return {
        feeSats: r.feeSats,
        outputs: r.outputs.map((o) => ({ ...o, isChange: ownAddresses.has(o.address) })),
      };
    } catch {
      return null;
    }
  }, [signedPsbt, ownAddresses]);

  async function handlePaste() {
    const clip = await Clipboard.getStringAsync();
    setRecipient(clip.trim());
  }

  function handleRecipientScanned(data: string) {
    setScanMode("none");
    setRecipient(data.trim());
  }

  async function handleBuild() {
    if (!canBuild) return;
    setBusyAction("build");
    setError(null);
    try {
      const built = await buildWatchPsbt(
        {
          zpub: watchOnly.zpub,
          fingerprint: parseInt(watchOnly.fingerprint, 16) >>> 0,
          accountDerivation: watchOnly.accountDerivation,
        },
        recipient.trim(),
        amountSats,
        fees[feeTier],
      );
      setUnsignedPsbt(built.psbtB64);
      setBuiltInfo({ feeSats: built.feeSats, inputCount: built.inputCount, changeIdx: built.changeIdx });
      setStage("unsigned");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/insufficient/i.test(msg) ? text.insufficientFunds : msg);
    } finally {
      setBusyAction(null);
    }
  }

  /**
   * 扫回已签 PSBT。**必须先证明它就是我发出去的那一笔,才允许进入确认页。**
   *
   * 【旧实现是整个气隙模型的命门】它只做了 setSignedPsbt(data) + setStage("confirm")，
   * 一行校验都没有。而确认页显示的 recipient / amount 读的是**用户自己在表单里
   * 输入的 state** —— 于是被掉包的离线设备、被替换的二维码，可以回传一笔收款方
   * 完全不同的已签交易，在线端会**显示你的原始意图**然后广播攻击者的交易。
   * 用户看到的"确认信息"是自己的意图，不是即将上链的事实。
   *
   * 隔离见证的 txid 不含见证数据，所以签名不改变 txid；反过来只要输入、输出、
   * 金额、sequence、locktime 任何一项被动过，txid 必变。比对 txid 比逐字段
   * 比对更强，也不会漏掉将来新增的交易字段。
   */
  function handleSignedScanned(data: string) {
    setScanMode("none");
    const scanned = data.trim();
    if (!unsignedPsbt) return;
    try {
      assertSamePsbtTransaction(unsignedPsbt, scanned);
    } catch (e) {
      if (e instanceof PsbtMismatchError) {
        setError(text.watchOnlyPsbtMismatch);
        return;
      }
      setError(text.watchOnlyPsbtInvalid);
      return;
    }
    // 一个签名都没有的 PSBT 广播必然失败，早点说清楚，别让节点回一句看不懂的错误。
    try {
      if (signedInputCount(scanned) === 0) {
        setError(text.watchOnlyPsbtUnsigned);
        return;
      }
    } catch {
      setError(text.watchOnlyPsbtInvalid);
      return;
    }
    setError(null);
    setSignedPsbt(scanned);
    setStage("confirm");
  }

  async function doBroadcast(signed: string) {
    setBusyAction("broadcast");
    setError(null);
    try {
      const { txid: id } = await broadcastSignedPsbt(signed);
      // 广播成功后持久化本次找零索引，防下次找零越扫描范围（P0-5）
      if (builtInfo) await commitWatchChangeIdx(watchOnly.zpub, builtInfo.changeIdx);
      setTxid(id);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  function reset() {
    setStage("form");
    setUnsignedPsbt(null);
    setBuiltInfo(null);
    setSignedPsbt(null);
    setTxid(null);
    setError(null);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flex: 1 }}>
        {scanMode !== "none" && (
          <QrScanner
            mode={scanMode === "signed" ? "psbt" : "single"}
            progressLabel={text.psbtScanProgress}
            onScanned={scanMode === "recipient" ? handleRecipientScanned : handleSignedScanned}
            onClose={() => setScanMode("none")}
            closeLabel={text.cancel}
            deniedTitle={text.vaultCosignCameraDeniedTitle}
            deniedBody={text.vaultCosignCameraDeniedBody}
            authorizeLabel={text.cameraAuthorize}
            scanHint={text.scanHint}
          />
        )}
        <View style={[styles.header, { marginTop: insets.top + 8 }]}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.backToWallet} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.backToWallet}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.watchOnlySendBuildPsbt}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {/* 操作指引 */}
          <View style={[styles.guideCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.guideTitle, { color: theme.text }]}>{text.watchOfflineGuideTitle}</Text>
            <Text style={[styles.guideStep, { color: theme.textSecondary }]}>{text.watchOfflineGuideStep1}</Text>
            <Text style={[styles.guideStep, { color: theme.textSecondary }]}>{text.watchOfflineGuideStep2}</Text>
            <Text style={[styles.guideStep, { color: theme.textSecondary }]}>{text.watchOfflineGuideStep3}</Text>
            <Text style={[styles.guideStep, { color: theme.textSecondary }]}>{text.watchOfflineGuideStep4}</Text>
          </View>

          {stage === "form" && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.watchOnlySendHint}</Text>
              <Text style={[styles.balance, { color: theme.text }]}>{satsToBtc(balance)} BTC</Text>

              <Text style={[styles.label, { color: theme.text }]}>{text.recipientAddress}</Text>
              <View style={[styles.inputRow, { borderColor: theme.inputBorder, backgroundColor: theme.input }]}>
                <TextInput
                  value={recipient}
                  onChangeText={setRecipient}
                  placeholder={text.recipientPlaceholder}
                  placeholderTextColor={theme.textMuted}
                  style={[styles.input, { color: theme.text }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <Pressable onPress={() => setScanMode("recipient")} accessibilityRole="button" accessibilityLabel={text.watchOnlyScanRecipient} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.watchOnlyScanRecipient}</Text>
                </Pressable>
                <Pressable onPress={handlePaste} accessibilityRole="button" accessibilityLabel={text.paste} hitSlop={8} style={[styles.smallBtn, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.paste}</Text>
                </Pressable>
              </View>

              <Text style={[styles.label, { color: theme.text }]}>{text.amountBtc}</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="0.001"
                placeholderTextColor={theme.textMuted}
                keyboardType="decimal-pad"
                style={[styles.amountInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              />

              <Text style={[styles.label, { color: theme.text }]}>{text.networkFee}</Text>
              <FeeSelector
                tiers={fees}
                selected={feeTier}
                onSelect={setFeeTier}
                labels={{
                  slow: text.feeSlow,
                  medium: text.feeMedium,
                  fast: text.feeFast,
                  slowTime: text.feeSlowTime,
                  mediumTime: text.feeMediumTime,
                  fastTime: text.feeFastTime,
                }}
              />

              <Pressable
                disabled={!canBuild}
                onPress={handleBuild}
                accessibilityRole="button"
                accessibilityLabel={text.watchOnlySendBuildPsbt}
                style={[styles.submitBtn, { backgroundColor: canBuild ? theme.primaryButton : theme.surface }]}
              >
                <Text style={[styles.submitBtnText, { color: canBuild ? theme.primaryButtonText : theme.textMuted }]}>
                  {text.watchOnlySendBuildPsbt}
                </Text>
              </Pressable>
              {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "unsigned" && unsignedPsbt && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.watchOnlySendHint}</Text>
              <PsbtQr
                psbtB64={unsignedPsbt}
                size={240}
                animatedHint={text.psbtAnimatedHint}
                unavailableHint={text.psbtUrUnavailable}
              />
              <Text style={[styles.psbtPreview, { color: theme.textMuted }]} numberOfLines={3}>{unsignedPsbt}</Text>
              <Pressable
                onPress={async () => { await Clipboard.setStringAsync(unsignedPsbt); }}
                accessibilityRole="button"
                accessibilityLabel={text.copy}
                hitSlop={8}
                style={[styles.smallBtn, { backgroundColor: theme.surface, alignSelf: "flex-start" }]}
              >
                <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.copy}</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                onPress={() => setScanMode("signed")}
                accessibilityRole="button"
                accessibilityLabel={text.watchOnlySendScanSigned}
                style={[styles.submitBtn, { backgroundColor: busy ? theme.surface : theme.incoming }]}
              >
                <Text style={[styles.submitBtnText, { color: busy ? theme.textMuted : theme.primaryButtonText }]}>
                  {busy ? text.sending : text.watchOnlySendScanSigned}
                </Text>
              </Pressable>
              <Pressable onPress={reset} accessibilityRole="button" accessibilityLabel={text.cancel} style={styles.linkBtn}>
                <Text style={[styles.linkText, { color: theme.accent }]}>{text.cancel}</Text>
              </Pressable>
              {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "confirm" && signedPsbt && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.hint, { color: theme.warning }]}>{text.watchOnlyConfirmTitle}</Text>
              <Text style={[styles.confirmHint, { color: theme.textSecondary }]}>{text.watchOnlyConfirmHint}</Text>
              {/* 这里的每一行都从**扫回来的已签 PSBT** 解码而来，不是表单输入。
                  旧实现显示的是用户的意图；现在显示的是即将上链的事实。
                  两者一致由 handleSignedScanned 的 txid 比对保证。 */}
              <Text style={[styles.confirmSource, { color: theme.incoming }]}>
                {text.watchOnlyConfirmVerified}
              </Text>
              {signedReview ? (
                <>
                  {signedReview.outputs.map((o, i) => (
                    <View key={i} style={[styles.confirmRow, { borderColor: theme.border }]}>
                      <Text style={[styles.confirmLabel, { color: theme.textSecondary }]}>
                        {o.isChange ? text.watchOnlyOutputChange : text.sendingTo}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.confirmValue, { color: theme.text }]} numberOfLines={2}>
                          {o.address}
                        </Text>
                        <Text style={[styles.confirmValue, { color: o.isChange ? theme.textMuted : theme.text, fontWeight: "900" }]}>
                          {satsToBtc(o.sats)} BTC
                        </Text>
                      </View>
                    </View>
                  ))}
                  <View style={[styles.confirmRow, { borderColor: theme.border }]}>
                    <Text style={[styles.confirmLabel, { color: theme.textSecondary }]}>{text.networkFee}</Text>
                    <Text style={[styles.confirmValue, { color: theme.text }]}>{signedReview.feeSats} sats</Text>
                  </View>
                </>
              ) : (
                <Text style={[styles.error, { color: theme.outgoing }]}>{text.watchOnlyPsbtInvalid}</Text>
              )}
              <Pressable
                disabled={busy}
                onPress={() => doBroadcast(signedPsbt)}
                accessibilityRole="button"
                accessibilityLabel={text.watchOnlyConfirmBroadcast}
                style={[styles.submitBtn, { backgroundColor: busy ? theme.surface : theme.primaryButton }]}
              >
                <Text style={[styles.submitBtnText, { color: busy ? theme.textMuted : theme.primaryButtonText }]}>
                  {busy ? text.sending : text.watchOnlyConfirmBroadcast}
                </Text>
              </Pressable>
              <Pressable onPress={reset} accessibilityRole="button" accessibilityLabel={text.cancel} style={styles.linkBtn}>
                <Text style={[styles.linkText, { color: theme.accent }]}>{text.cancel}</Text>
              </Pressable>
              {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
            </View>
          )}

          {stage === "done" && txid && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.hint, { color: theme.incoming }]}>{text.sendSuccess}</Text>
              <Text style={[styles.label, { color: theme.textSecondary }]}>txid</Text>
              <Text style={[styles.txid, { color: theme.text }]} selectable>{txid}</Text>
              <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.backToWallet} style={[styles.submitBtn, { backgroundColor: theme.primaryButton }]}>
                <Text style={[styles.submitBtnText, { color: theme.primaryButtonText }]}>{text.backToWallet}</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
        <LoadingOverlay
          visible={busy}
          label={busyAction === "broadcast" ? text.busyWatchBroadcasting : text.busyWatchBuildingPsbt}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  guideCard: { padding: 14, borderRadius: 10, borderWidth: 1, gap: 6 },
  guideTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 0.3 },
  guideStep: { fontSize: 12, lineHeight: 17 },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 12 },
  hint: { fontSize: 12, lineHeight: 17 },
  balance: { fontSize: 18, fontWeight: "900" },
  label: { fontSize: 13, fontWeight: "900" },
  inputRow: { flexDirection: "row", borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, alignItems: "flex-end", gap: 6 },
  input: { flex: 1, minHeight: 56, fontSize: 12, fontFamily: "monospace", padding: 4 },
  amountInput: { minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  smallBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  smallBtnText: { fontSize: 11, fontWeight: "900" },
  submitBtn: { minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 14, fontWeight: "900" },
  linkBtn: { alignItems: "center", paddingVertical: 8 },
  linkText: { fontSize: 12, fontWeight: "900" },
  error: { fontSize: 12 },
  qrWrap: { alignItems: "center", paddingVertical: 8 },
  psbtPreview: { fontSize: 10, fontFamily: "monospace" },
  txid: { fontSize: 12, fontFamily: "monospace" },
  confirmHint: { fontSize: 12, lineHeight: 17 },
  confirmRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 10, borderBottomWidth: 1 },
  confirmLabel: { fontSize: 12, fontWeight: "900" },
  confirmSource: { fontSize: 11, fontWeight: "900", lineHeight: 16 },
  confirmValue: { flex: 1, fontSize: 12, fontFamily: "monospace", textAlign: "right" },
});
