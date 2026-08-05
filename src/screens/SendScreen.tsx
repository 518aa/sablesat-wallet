import * as Clipboard from "expo-clipboard";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { useAssets } from "../hooks/useAssets";
import { BTC_ASSET, EVM_CHAINS, type AssetDef, type ChainId } from "../chains/tokens";
import { transferAsset, validateEvmAddress, estimateEvmGas } from "../services/evm";
import { fetchFeeEstimates } from "../services/blockchain";
import { buildAndSendTx, DustChangeError, estimateSendFeeSats, previewSendTx, prefetchWalletUtxos, IncompleteDataError } from "../services/transaction";
import { SelfSendError, InsufficientBalanceError, InvalidAddressError } from "../services/errors";
import { authenticate, getAvailableAuthMethod, verifyPin } from "../services/auth";
import { PinDialog } from "../components/PinDialog";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { QrScanModal } from "../components/QrScanModal";
import { AddressConfirmDialog } from "../components/AddressConfirmDialog";
import { FeeSelector, type FeeTier } from "../components/FeeSelector";
import { btcToSatsOrNull, satsToBtc, validateBtcAddress } from "../utils/bitcoin";
import { hapticImpact } from "../utils/haptics";
import { press, tnum } from "../theme-tokens";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  btcAddress: string;
  evmAddress: string;
  text: ReturnTypeT;
  onBack: () => void;
};

export function SendScreen({ btcAddress, evmAddress, text, onBack }: Props) {
  const { theme } = useTheme();
  const { btc, assets, groups, busy, refresh } = useAssets(evmAddress);
  const [assetId, setAssetId] = useState("btc");
  const [expanded, setExpanded] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feeTier, setFeeTier] = useState<FeeTier>("medium");
  const [fees, setFees] = useState({ slow: 2, medium: 5, fast: 20 });
  const [feeEstimate, setFeeEstimate] = useState(0);
  const [feeReady, setFeeReady] = useState(false);
  const [feePreviewKey, setFeePreviewKey] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busySend, setBusySend] = useState(false);
  const sendingRef = useRef(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinError, setPinError] = useState("");
  const pendingSendRef = useRef(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [scanVisible, setScanVisible] = useState(false);
  const [evmGasEstimate, setEvmGasEstimate] = useState<string | null>(null);
  const [evmGasEstimating, setEvmGasEstimating] = useState(false);
  // previewSendTx 失败时区分：IncompleteDataError（部分地址未扫到）需向用户显式提示重试，
  // 旧实现一律静默 setFeeReady(false)，用户只看到"合计 --"和灰色确认按钮，不知为何卡住。
  const [previewError, setPreviewError] = useState<{ retryable: boolean; message: string } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  // previewSendTx 进行中：合计行显示 spinner + "估算中"，给用户明确反馈（旧版只有灰色按钮无提示）。
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    fetchFeeEstimates().then(setFees).catch((error) => {
      logger.warn("Failed to load fee estimates", error);
    });
    // 进发送页即后台预热 UTXO 缓存：用户填完金额时大概率命中缓存、合计秒出。
    // httpQueue 的 in-flight GET 去重会合并预热与正式 preview 的重复请求，不额外耗流量。
    void prefetchWalletUtxos();
  }, []);

  const selectable: AssetDef[] = [BTC_ASSET, ...assets.map((a) => a.asset)];
  const selected = selectable.find((a) => a.id === assetId) ?? BTC_ASSET;
  const selectedBalance = assets.find((a) => a.asset.id === assetId)?.displayBalance ?? "0";

  // btcToSatsOrNull 对非法输入返回 null（旧实现静默返回 0，UI 无法区分
  // 「无效输入」与「零金额」）。这里统一收敛为 0 用于比较，实际发送前会再校验。
  const amountSatsRaw = useMemo(() => btcToSatsOrNull(amount), [amount]);
  const amountSats = amountSatsRaw ?? 0;
  const amountInvalid = amount.trim() !== "" && amountSatsRaw === null;
  const availableSats = btc.balanceSats ?? 0;
  const currentFeeKey = `${amountSats}:${fees[feeTier]}:${feeTier}`;
  const maxFeeEstimate = feeEstimate || estimateSendFeeSats(1, fees[feeTier]);

  useEffect(() => {
    let cancelled = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (selected.kind !== "btc") {
      setFeeReady(true);
      setPreviewing(false);
      return () => { cancelled = true; if (debounceRef.current) clearTimeout(debounceRef.current); };
    }
    if (amountSats <= 0) {
      setFeeEstimate(0);
      setFeeReady(false);
      setFeePreviewKey("");
      setPreviewing(false);
      return () => { cancelled = true; };
    }
    setFeeReady(false);
    setFeePreviewKey("");
    setPreviewError(null);
    setPreviewing(true);
    debounceRef.current = setTimeout(() => {
      previewSendTx(amountSats, fees[feeTier])
        .then((preview) => {
          if (!cancelled) {
            setFeeEstimate(preview.feeSats);
            setFeePreviewKey(currentFeeKey);
            setFeeReady(true);
            setPreviewError(null);
            setPreviewing(false);
          }
        })
        .catch((error) => {
          logger.warn("Failed to preview transaction fee", error);
          if (!cancelled) {
            setFeeEstimate(0);
            setFeePreviewKey("");
            setFeeReady(false);
            setPreviewing(false);
            const isRetryable = error instanceof IncompleteDataError;
            setPreviewError({
              retryable: isRetryable,
              message: isRetryable
                ? text.sendPreviewIncomplete
                : error instanceof Error
                  ? error.message
                  : String(error),
            });
          }
        });
    }, 300);
    return () => { cancelled = true; if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [amountSats, currentFeeKey, fees, feeTier, selected.kind, retryKey]);

  useEffect(() => {
    if (selected.kind === "btc") {
      setEvmGasEstimate(null);
      return;
    }
    if (!recipient.trim() || !amount.trim() || !validateEvmAddress(recipient.trim())) {
      setEvmGasEstimate(null);
      return;
    }
    let cancelled = false;
    setEvmGasEstimating(true);
    const timeout = setTimeout(async () => {
      try {
        const result = await estimateEvmGas(selected, evmAddress, recipient.trim(), amount);
        if (!cancelled) {
          setEvmGasEstimate(result.displayCost);
        }
      } catch {
        if (!cancelled) setEvmGasEstimate(null);
      } finally {
        if (!cancelled) setEvmGasEstimating(false);
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [selected, amount, recipient, evmAddress]);

  async function handlePaste() {
    hapticImpact("light");
    const clip = await Clipboard.getStringAsync();
    setRecipient(clip);
  }

  // 解析扫码结果：支持 bitcoin:/ethereum: 协议及 ?amount= 参数；BTC 且带 amount 时自动填充金额。
  function applyScanned(raw: string) {
    const trimmed = raw.trim();
    const m = trimmed.match(/^([a-zA-Z]+):([^?]+)(?:\?(.*))?$/);
    if (m) {
      const scheme = m[1].toLowerCase();
      const value = m[2].split("/")[0];
      if (scheme === "bitcoin" && selected.kind === "btc") {
        if (!validateBtcAddress(value)) return Alert.alert("SableSat", text.invalidAddress);
        setRecipient(value);
        const params = new URLSearchParams(m[3] ?? "");
        const amt = params.get("amount");
        if (amt) setAmount(amt);
        return;
      }
      setRecipient(value);
      return;
    }
    // 裸地址：按当前资产类型校验
    if (isEvm(selected) && !validateEvmAddress(trimmed)) return Alert.alert("SableSat", text.invalidAddress);
    if (!isEvm(selected) && !validateBtcAddress(trimmed)) return Alert.alert("SableSat", text.invalidAddress);
    setRecipient(trimmed);
  }

  function isEvm(asset: AssetDef) {
    return asset.kind !== "btc";
  }

  async function handleSend() {
    if (sendingRef.current) return;
    if (isEvm(selected)) {
      if (!validateEvmAddress(recipient)) return Alert.alert("SableSat", text.invalidAddress);
      if (!amount.trim() || Number(amount) <= 0) return Alert.alert("SableSat", text.insufficientFunds);
      if (Number(amount) > Number(selectedBalance)) return Alert.alert("SableSat", text.insufficientFunds);
    } else {
      if (!validateBtcAddress(recipient)) return Alert.alert("SableSat", text.invalidAddress);
      if (!feeReady || feePreviewKey !== currentFeeKey) return Alert.alert("SableSat", text.networkFee);
      if (amountSats <= 0 || amountSats + feeEstimate > availableSats) return Alert.alert("SableSat", text.insufficientFunds);
    }
    hapticImpact("medium");
    setPendingConfirm(true);
  }

  async function proceedAfterConfirm() {
    setPendingConfirm(false);
    const method = await getAvailableAuthMethod();
    if (method === "biometric") {
      const authorized = await authenticate(text.biometricPrompt);
      if (!authorized) return;
    } else if (method === "pin") {
      pendingSendRef.current = true;
      setShowPinDialog(true);
      setPinError("");
      return;
    } else {
      return Alert.alert("SableSat", text.biometricFallback);
    }
    await executeSend();
  }

  async function executeSend() {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setBusySend(true);
    try {
      if (isEvm(selected)) {
        const tx = await transferAsset(selected, recipient.trim(), amount);
        await refresh();
        Alert.alert("SableSat", `${text.sendSuccess}\n${tx.hash}`, [{ text: "OK", onPress: onBack }]);
        return;
      }
      await buildAndSendTx(recipient.trim(), amountSats, fees[feeTier]);
      await refresh();
      Alert.alert("SableSat", text.sendSuccess, [{ text: "OK", onPress: onBack }]);
    } catch (error) {
      if (error instanceof DustChangeError) {
        Alert.alert("SableSat", `${text.dustChangeWarning}: ${error.dustSats} sats`);
        return;
      }
      let msg: string = text.sendFailed;
      if (error instanceof SelfSendError) msg = text.selfSendError;
      else if (error instanceof InsufficientBalanceError) msg = text.insufficientFunds;
      else if (error instanceof InvalidAddressError) msg = text.invalidAddress;
      else if (error instanceof Error) msg = `${text.sendFailed}: ${error.message}`;
      Alert.alert("SableSat", msg);
    } finally {
      sendingRef.current = false;
      setBusySend(false);
    }
  }

  async function handleSendPinSubmit(pin: string) {
    const valid = await verifyPin(pin);
    if (!valid) {
      setPinError(text.pinVerifyError);
      return;
    }
    setShowPinDialog(false);
    pendingSendRef.current = false;
    await executeSend();
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={[styles.content, { backgroundColor: theme.bg }]}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.back} hitSlop={8} style={({ pressed }) => [styles.backChip, { backgroundColor: theme.surface }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
        <Text style={{ color: theme.accent, fontWeight: "900" }}>{text.backToWallet}</Text>
      </Pressable>
      <Text style={[styles.title, { color: theme.text }]}>{text.sendTitle}</Text>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{text.asset}</Text>
        <View style={styles.assetPicker}>
          <Pressable onPress={() => { hapticImpact("light"); setAssetId("btc"); }} style={({ pressed }) => [styles.assetChip, { backgroundColor: assetId === "btc" ? `${theme.accent}22` : theme.surface, borderColor: assetId === "btc" ? theme.accent : theme.border }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
            <Text style={[styles.assetChipText, { color: assetId === "btc" ? theme.accent : theme.text }]}>BTC</Text>
            <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>Bitcoin</Text>
          </Pressable>
          <Pressable onPress={() => { hapticImpact("light"); setExpanded((v) => !v); }} accessibilityRole="button" accessibilityLabel={text.moreAssets} hitSlop={8} style={({ pressed }) => [styles.assetChip, { backgroundColor: theme.surface, borderColor: theme.border }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
            <Text style={[styles.assetChipText, { color: theme.text }]}>{text.moreAssets}</Text>
            <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>{expanded ? "▲" : "▼"}</Text>
          </Pressable>
        </View>

        {expanded && groups.map((g) => (
          <View key={g.chain} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.textSecondary }]}>{EVM_CHAINS[g.chain as ChainId].name}</Text>
            <View style={styles.assetPicker}>
              {g.assets.map((view) => (
                <Pressable key={view.asset.id} onPress={() => { hapticImpact("light"); setAssetId(view.asset.id); setExpanded(false); }} style={({ pressed }) => [styles.assetChip, { backgroundColor: assetId === view.asset.id ? `${theme.accent}22` : theme.surface, borderColor: assetId === view.asset.id ? theme.accent : theme.border }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
                  <Text style={[styles.assetChipText, { color: assetId === view.asset.id ? theme.accent : theme.text }]}>{view.asset.symbol}</Text>
                  <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>{EVM_CHAINS[g.chain as ChainId].shortName}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}

        <Text style={[styles.label, { color: theme.text }]}>{text.recipientAddress}</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={recipient}
            onChangeText={setRecipient}
            placeholder={isEvm(selected) ? "0x..." : text.recipientPlaceholder}
            placeholderTextColor={theme.textMuted}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, flex: 1 }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable onPress={handlePaste} accessibilityRole="button" accessibilityLabel={text.paste} hitSlop={8} style={({ pressed }) => [styles.smallBtn, { backgroundColor: theme.secondaryButton }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
            <Text style={{ color: theme.secondaryButtonText, fontWeight: "900", fontSize: 12 }}>{text.paste}</Text>
          </Pressable>
          <Pressable onPress={() => { hapticImpact("light"); setScanVisible(true); }} accessibilityRole="button" accessibilityLabel={text.scan} hitSlop={8} style={({ pressed }) => [styles.smallBtn, { backgroundColor: theme.secondaryButton }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
            <Text style={{ color: theme.secondaryButtonText, fontWeight: "900", fontSize: 12 }}>{text.scan}</Text>
          </Pressable>
        </View>

        <Text style={[styles.label, { color: theme.text }]}>{isEvm(selected) ? `${text.amount} (${selected.symbol})` : text.amountBtc}</Text>
        <View style={styles.inputRow}>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.001"
            placeholderTextColor={theme.textMuted}
            style={[styles.input, tnum, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, flex: 1 }]}
          />
          <Pressable disabled={isEvm(selected) ? !selectedBalance : !feeReady} onPress={() => { hapticImpact("light"); setAmount(isEvm(selected) ? selectedBalance : satsToBtc(Math.max(0, availableSats - maxFeeEstimate))); }} accessibilityRole="button" accessibilityLabel={text.max} hitSlop={8} style={({ pressed }) => [styles.smallBtn, { backgroundColor: theme.secondaryButton }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
            <Text style={{ color: theme.secondaryButtonText, fontWeight: "900", fontSize: 12 }}>{text.max}</Text>
          </Pressable>
        </View>
        <Text style={[tnum, { color: theme.textSecondary, fontSize: 12 }]}>
          {text.available}: {isEvm(selected) ? `${selectedBalance} ${selected.symbol}` : `${satsToBtc(availableSats)} BTC`}
        </Text>

        {isEvm(selected) ? (
          <View style={[styles.notice, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
              {text.stablecoinFeeHint.replace("{network}", EVM_CHAINS[selected.chainId as ChainId].shortName).replace("{fee}", EVM_CHAINS[selected.chainId as ChainId].feeSymbol)}
            </Text>
            {evmGasEstimate && (
              <Text style={[tnum, { color: theme.textSecondary, fontSize: 12, marginTop: 6 }]}>
                {text.sendEstimatedGas.replace("{fee}", evmGasEstimate)}
              </Text>
            )}
            {evmGasEstimating && !evmGasEstimate && (
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 6 }}>
                {text.sendEstimatingGas}
              </Text>
            )}
          </View>
        ) : (
          <>
            <Text style={[styles.label, { color: theme.text }]}>{text.networkFee}</Text>
            <FeeSelector tiers={fees} selected={feeTier} onSelect={setFeeTier} labels={{ slow: text.feeSlow, medium: text.feeMedium, fast: text.feeFast, slowTime: text.feeSlowTime, mediumTime: text.feeMediumTime, fastTime: text.feeFastTime }} />
          </>
        )}

        <View style={[styles.totalRow, { borderTopColor: theme.border }]}>
          <Text style={{ color: theme.textSecondary, fontWeight: "800" }}>{text.total}</Text>
          {isEvm(selected) ? (
            <Text style={[tnum, { color: theme.text, fontWeight: "900" }]}>{amount || "0"} {selected.symbol}</Text>
          ) : previewing ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={theme.text} />
              <Text style={[tnum, { color: theme.text, fontWeight: "900" }]}>{text.estimating}</Text>
            </View>
          ) : (
            <Text style={[tnum, { color: theme.text, fontWeight: "900" }]}>{feeReady ? satsToBtc(amountSats + feeEstimate) : "--"} BTC</Text>
          )}
        </View>
      </View>

      {selected.kind === "btc" && previewError && (
        <View style={[styles.previewErrorCard, { backgroundColor: theme.surface, borderColor: theme.outgoing }]}>
          <Text style={{ color: theme.outgoing, fontSize: 13, fontWeight: "800", flex: 1 }}>{previewError.message}</Text>
          {previewError.retryable && (
            <Pressable onPress={() => { hapticImpact("light"); setRetryKey((k) => k + 1); }} accessibilityRole="button" accessibilityLabel={text.retry} hitSlop={8} style={({ pressed }) => [styles.retryBtn, { backgroundColor: theme.secondaryButton }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
              <Text style={{ color: theme.secondaryButtonText, fontWeight: "900", fontSize: 12 }}>{text.retry}</Text>
            </Pressable>
          )}
        </View>
      )}

      <Pressable disabled={busySend || (isEvm(selected) ? !amount.trim() : !feeReady)} onPress={handleSend} accessibilityRole="button" accessibilityLabel={text.confirmSend} style={({ pressed }) => [styles.sendBtn, { backgroundColor: busySend || (isEvm(selected) ? !amount.trim() : !feeReady) ? theme.surface : theme.primaryButton }, pressed && { transform: [{ scale: press.scale }], opacity: 0.85 }]}>
        {busySend ? <ActivityIndicator color={theme.primaryButtonText} /> : <Text style={{ color: theme.primaryButtonText, fontWeight: "900", fontSize: 16 }}>{text.confirmSend}</Text>}
      </Pressable>

      <PinDialog
        visible={showPinDialog}
        title={text.pinVerifyTitle}
        subtitle={text.pinVerifySubtitle}
        errorText={pinError || undefined}
        cancelLabel={text.cancel}
        onPinEntered={handleSendPinSubmit}
        onCancel={() => {
          setShowPinDialog(false);
          pendingSendRef.current = false;
        }}
      />

      <AddressConfirmDialog
        visible={pendingConfirm}
        theme={theme}
        address={recipient.trim()}
        amountLabel={isEvm(selected) ? `${amount || "0"} ${selected.symbol}` : `${satsToBtc(amountSats)} BTC`}
        assetLabel={isEvm(selected) ? `${selected.symbol} · ${EVM_CHAINS[selected.chainId as ChainId].shortName}` : "Bitcoin · mainnet"}
        title={text.addressConfirmTitle}
        subtitle={text.addressConfirmSubtitle}
        warningText={text.riskText}
        confirmLabel={text.addressConfirmAction}
        cancelLabel={text.cancel}
        onConfirm={proceedAfterConfirm}
        onCancel={() => setPendingConfirm(false)}
      />
      <LoadingOverlay visible={busySend} label={text.sending} />

      <QrScanModal
        visible={scanVisible}
        text={text}
        onScan={(data) => {
          applyScanned(data);
          setScanVisible(false);
        }}
        onClose={() => setScanVisible(false)}
      />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 12, gap: 14, paddingBottom: 96 },
  backChip: { alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9 },
  title: { fontSize: 26, fontWeight: "900" },
  card: { padding: 16, borderRadius: 8, gap: 12, borderWidth: 1 },
  assetPicker: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  group: { gap: 8, marginTop: 4 },
  groupTitle: { fontSize: 12, fontWeight: "900", marginLeft: 2 },
  assetChip: { minWidth: 78, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  assetChipText: { fontSize: 13, fontWeight: "900" },
  assetChipSub: { fontSize: 10, fontWeight: "800", marginTop: 2 },
  label: { fontWeight: "900", marginTop: 4, fontSize: 13 },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { minHeight: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  smallBtn: { minHeight: 48, paddingHorizontal: 12, borderRadius: 8, justifyContent: "center" },
  notice: { borderWidth: 1, borderRadius: 8, padding: 12 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 12, borderTopWidth: 1, marginTop: 4 },
  sendBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  previewErrorCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 8, padding: 12 },
  retryBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
});
