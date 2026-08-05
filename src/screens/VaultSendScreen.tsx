import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState } from "react";
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
import { QrScanModal } from "../components/QrScanModal";
import { PsbtQr } from "../components/PsbtQr";
import { FeeSelector, type FeeTier } from "../components/FeeSelector";
import { useTheme } from "../hooks/useTheme";
import { useVault } from "../hooks/useVault";
import {
  buildVaultPsbt,
  estimateMultisigVbytes,
  signVaultPsbtSelf,
  vaultInputVbytes,
  VaultDustChangeError,
  VAULT_OUTPUT_VBYTES,
  VAULT_OVERHEAD_VBYTES,
} from "../services/vault/psbt";
import { selectCoins } from "../services/coinSelection";
import { commitVaultIndex } from "../services/vault/scan";
import { DUST_THRESHOLD_SATS } from "../utils/bitcoin";
import { isWalletUnlocked, getRootUnlocked } from "../services/wallet";
import { fetchBlockHeight, fetchFeeEstimates } from "../services/blockchain";
import { validateBtcAddress } from "../utils/bitcoin";
import { btcToSatsOrNull, satsToBtc, parseBitcoinUri } from "../utils/bitcoin";
import type { VaultUtxo } from "../services/vault/types";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  vaultId: string;
  text: ReturnTypeT;
  onBack: () => void;
};

export function VaultSendScreen({ vaultId, text, onBack }: Props) {
  const { theme } = useTheme();
  const { vault, utxos, totalSats, maxChangeIndex, complete, loading, refresh } = useVault(vaultId);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [feeTier, setFeeTier] = useState<FeeTier>("medium");
  const [fees, setFees] = useState({ slow: 2, medium: 5, fast: 20 });
  const [signedPsbt, setSignedPsbt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => {
    fetchFeeEstimates()
      .then(setFees)
      .catch((err) => logger.warn("Failed to load fee estimates", err));
  }, []);

  // btcToSatsOrNull 对非法输入返回 null（旧实现静默返回 0，UI 无法区分
  // 「无效输入」与「零金额」）。这里统一收敛为 0 用于比较，实际发送前会再校验。
  const amountSatsRaw = useMemo(() => btcToSatsOrNull(amount), [amount]);
  const amountSats = amountSatsRaw ?? 0;
  const amountInvalid = amount.trim() !== "" && amountSatsRaw === null;

  // 「确认发送」按钮为什么是灰的 —— 必须能说出来。
  //
  // 【旧实现的问题】canBuild 是 6 个条件的 && 串。任何一条不满足按钮就是灰的，
  // 而 UI **一个字都不解释**。实际最常踩到的是 `utxos.length > 0`：金库扫描被
  // 第三方 API 限流（旧代码还把 HTTP 500 当成"这个地址没有 UTXO"）时 utxos 是
  // 空的，用户明明看得见余额、地址金额也填对了，按钮就是按不下去，且无从判断
  // 该重试还是该改金额。现在把原因算出来显示在按钮下面。
  const blockReason: string | null = useMemo(() => {
    if (!vault) return text.vaultNotFound;
    if (loading) return text.loading;
    // 扫不到 UTXO ≠ 没钱：数据不完整时提示重试，真·零余额才说余额不足。
    if (utxos.length === 0) {
      return complete && totalSats === 0 ? text.insufficientFunds : text.vaultSendScanFailed;
    }
    if (!complete) return text.balanceIncomplete;
    if (!recipient.trim()) return text.vaultSendNeedAddress;
    if (!validateBtcAddress(recipient.trim())) return text.invalidAddress;
    if (amountInvalid) return text.invalidAmount;
    if (amountSats <= 0) return text.vaultSendNeedAmount;
    // 手续费必须算进去。旧实现只比 amountSats <= totalSats，于是"全额转出"时
    // 按钮是亮的，点下去才在 buildVaultPsbt 里抛 Insufficient funds。
    const estFee = Math.ceil(
      estimateMultisigVbytes(Math.max(1, utxos.length), 2, vault.m, vault.n) * (fees[feeTier] || 1),
    );
    if (amountSats + estFee > totalSats) return text.insufficientFunds;
    return null;
  }, [vault, loading, utxos, complete, recipient, amountInvalid, amountSats, totalSats, fees, feeTier, text]);

  const canBuild = blockReason === null && !busy;

  // 币选走**和单签同一套** BnB + SRD（services/coinSelection），只是把
  // P2WPKH 的尺寸参数换成 P2WSH 多签的。
  //
  // 【旧实现是 largest-first 手写循环】从最大的 UTXO 开始塞，够了就停。它不看
  // costOfChange —— 于是经常停在一个「剩余额刚好卡在 dust 区间」的组合上，
  // buildVaultPsbt 随后抛 `Change below dust threshold: 92 sats`，而用户无论
  // 怎么调金额都可能再撞上另一个零头。BnB 的目标区间恰恰是
  // [target, target + costOfChange]，就是为了优先找出**不需要找零**的组合。
  const selectedInputs = useMemo(() => {
    if (!vault || amountSats <= 0 || utxos.length === 0) return [];
    try {
      return selectCoins({
        utxos,
        targetSats: amountSats,
        feeRate: fees[feeTier] || 1,
        inputVbytes: vaultInputVbytes(vault.m, vault.n),
        outputVbytes: VAULT_OUTPUT_VBYTES,
        overheadVbytes: VAULT_OVERHEAD_VBYTES,
        dustThreshold: DUST_THRESHOLD_SATS,
      }).selected;
    } catch {
      // 凑不出解（余额不足 / 全是 dust）——交给 blockReason 与 buildVaultPsbt 报错。
      return [];
    }
  }, [utxos, amountSats, vault, fees, feeTier]);

  // 找零索引 **只前进不复用**：取「持久化的最高已用索引」与「本次输入里的最高
  // 找零索引」的较大者 +1。
  //
  // 【旧实现会复用地址】它挑的是 changeAddresses(0..19) 里第一个当前**没有
  // UTXO** 的索引 —— 一个已经用过、但找零已被花掉的地址会被重新选中。金库的
  // 收款地址本来就固定在 index 0（详情页只显示 receiveAddresses[0]），找零再
  // 复用，整个金库的链上足迹就压缩到极少数几个地址上，完全可关联。
  // 而且它上限卡在 19，与新的生长式扫描窗口对不上。
  const changeIndex = useMemo(() => {
    if (!vault) return 0;
    const maxInInputs = utxos
      .filter((u) => u.isChange)
      .reduce((m, u) => Math.max(m, u.derivationIndex), -1);
    return Math.max(maxChangeIndex, maxInInputs) + 1;
  }, [vault, utxos, maxChangeIndex]);

  async function handlePaste() {
    const clip = await Clipboard.getStringAsync();
    setRecipient(clip.trim());
  }

  function handleScan(raw: string) {
    const parsed = parseBitcoinUri(raw);
    if (parsed) {
      setRecipient(parsed.address);
      if (parsed.amountSats !== undefined) setAmount(satsToBtc(parsed.amountSats));
    } else {
      setRecipient(raw.trim());
    }
    setScanOpen(false);
  }

  async function handleCopyPsbt() {
    if (!signedPsbt) return;
    await Clipboard.setStringAsync(signedPsbt);
    Alert.alert(text.appName, text.copied);
  }

  async function handleBuild(acceptDustToFee = false) {
    if (!vault || !canBuild) return;
    setBusy(true);
    try {
      if (!isWalletUnlocked()) throw new Error("Wallet locked");
      let lockTime = 0;
      try { lockTime = await fetchBlockHeight(); } catch { /* skip */ }
      const psbt = buildVaultPsbt({
        vault,
        inputs: selectedInputs,
        recipients: [{ address: recipient.trim(), sats: amountSats }],
        changeIsChange: true,
        changeIndex,
        feeRate: fees[feeTier],
        lockTime,
        acceptDustToFee,
      });
      const signed = signVaultPsbtSelf(psbt, vault, selectedInputs, getRootUnlocked());
      // 记录本次用掉的找零索引，让下次扫描窗口跟着往外扩。
      // 广播发生在协签端（可能是另一台设备），所以在构造成功时就提交 ——
      // 最坏情况是白跳过一个索引，gap limit 会覆盖掉，无害。
      await commitVaultIndex(vault.id, "change", changeIndex);
      setSignedPsbt(signed);
    } catch (err) {
      // 零头高于 dust：建得出找零但不划算。金额可感知，让用户自己拍板，
      // 而不是像旧实现那样直接把整笔交易堵死。
      if (err instanceof VaultDustChangeError) {
        Alert.alert(
          text.appName,
          text.vaultDustToFeeConfirm.replace("{sats}", String(err.dustSats)),
          [
            { text: text.cancel, style: "cancel" },
            { text: text.confirmSend, onPress: () => void handleBuild(true) },
          ],
        );
        return;
      }
      logger.warn("Build/sign PSBT failed", err);
      Alert.alert(text.appName, err instanceof Error ? err.message : text.sendFailed);
    } finally {
      setBusy(false);
    }
  }

  if (!vault) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{loading ? text.loading : "Vault not found"}</Text>
      </View>
    );
  }

  if (signedPsbt) {
    return (
      <ScrollView style={[styles.container, { backgroundColor: theme.bg }]} contentContainerStyle={styles.body}>
        <View style={styles.header}>
          <Pressable onPress={() => setSignedPsbt(null)} accessibilityRole="button" accessibilityLabel={text.cancel} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.cancel}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.vaultDetailSend}</Text>
          <View style={{ width: 64 }} />
        </View>

        <PsbtSummary psbtB64={signedPsbt} vault={vault} knownInputs={selectedInputs} signaturesNeeded={vault.m} text={text} />

        <View style={[styles.qrCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <PsbtQr
            psbtB64={signedPsbt}
            size={240}
            hint={text.vaultScanQrHint}
            animatedHint={text.psbtAnimatedHint}
            unavailableHint={text.psbtUrUnavailable}
          />
          <Text style={[styles.psbtText, { color: theme.textMuted }]} numberOfLines={3} ellipsizeMode="tail">
            {signedPsbt}
          </Text>
          <Pressable onPress={handleCopyPsbt} accessibilityRole="button" accessibilityLabel={text.copy} hitSlop={8} style={[styles.copyBtn, { backgroundColor: theme.surface }]}>
            <Text style={[styles.copyBtnText, { color: theme.text }]}>{text.copy}</Text>
          </Pressable>
        </View>

        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.backToWallet} style={[styles.doneBtn, { backgroundColor: theme.primaryButton }]}>
          <Text style={[styles.doneBtnText, { color: theme.primaryButtonText }]}>{text.backToWallet}</Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={styles.header}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={text.vaultBackToList} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.vaultBackToList}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.vaultDetailSend}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.balanceCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.balanceLabel, { color: theme.textSecondary }]}>{text.available}</Text>
            <Text style={[styles.balanceValue, { color: theme.text }]}>{(totalSats / 1e8).toFixed(8)}</Text>
            <Text style={[styles.balanceUnit, { color: theme.textMuted }]}>BTC</Text>
          </View>

          <View style={[styles.inputCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.recipientAddress}</Text>
            <View style={[styles.textInputRow, { borderColor: theme.inputBorder, backgroundColor: theme.input }]}>
              <TextInput
                value={recipient}
                onChangeText={setRecipient}
                placeholder={text.recipientPlaceholder}
                placeholderTextColor={theme.textMuted}
                style={[styles.textInput, { color: theme.text }]}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              <Pressable onPress={() => setScanOpen(true)} accessibilityRole="button" accessibilityLabel={text.vaultCosignScan} hitSlop={8} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.vaultCosignScan}</Text>
              </Pressable>
              <Pressable onPress={handlePaste} accessibilityRole="button" accessibilityLabel={text.paste} hitSlop={8} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.paste}</Text>
              </Pressable>
            </View>

            <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 12 }]}>{text.amountBtc}</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="0.0000"
              placeholderTextColor={theme.textMuted}
              keyboardType="numeric"
              style={[styles.amountInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 12 }]}>{text.networkFee}</Text>
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
          </View>

          <Pressable
            disabled={!canBuild}
            onPress={() => void handleBuild()}
            accessibilityRole="button"
            accessibilityLabel={text.confirmSend}
            style={[styles.submitBtn, { backgroundColor: canBuild ? theme.primaryButton : theme.surface }]}
          >
            <Text style={[styles.submitBtnText, { color: canBuild ? theme.primaryButtonText : theme.textMuted }]}>
              {busy ? text.sending : text.confirmSend}
            </Text>
          </Pressable>

          {blockReason && !busy && (
            <View style={{ gap: 8 }}>
              <Text style={[styles.metaText, { color: theme.outgoing }]}>{blockReason}</Text>
              {(!complete || utxos.length === 0) && (
                <Pressable
                  onPress={() => refresh()}
                  accessibilityRole="button"
                  accessibilityLabel={text.retry}
                  style={[styles.copyBtn, { backgroundColor: theme.surface, alignSelf: "center" }]}
                >
                  <Text style={[styles.copyBtnText, { color: theme.text }]}>{text.retry}</Text>
                </Pressable>
              )}
            </View>
          )}

          {selectedInputs.length > 0 && (
            <Text style={[styles.metaText, { color: theme.textMuted }]}>
              {`${selectedInputs.length} inputs selected · change at index ${changeIndex}`}
            </Text>
          )}
        </ScrollView>
      </View>
      <QrScanModal visible={scanOpen} text={text} onScan={handleScan} onClose={() => setScanOpen(false)} />
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
  hint: { fontSize: 13, textAlign: "center", paddingTop: 24 },
  balanceCard: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 2 },
  balanceLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 0.4 },
  balanceValue: { fontSize: 26, fontWeight: "900" },
  balanceUnit: { fontSize: 12, fontWeight: "900" },
  inputCard: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "900", letterSpacing: 0.4 },
  textInputRow: { flexDirection: "row", borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, gap: 6, alignItems: "flex-end" },
  textInput: { flex: 1, minHeight: 56, fontSize: 12, fontFamily: "monospace", padding: 4 },
  pasteBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  pasteBtnText: { fontSize: 11, fontWeight: "900" },
  amountInput: { minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  submitBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 15, fontWeight: "900" },
  metaText: { fontSize: 11, textAlign: "center", letterSpacing: 0.4 },
  qrCard: { padding: 18, borderRadius: 12, borderWidth: 1, alignItems: "center", gap: 12 },
  qrHint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  tooLongCard: { paddingVertical: 18, paddingHorizontal: 14, gap: 6, alignItems: "center" },
  tooLongTitle: { fontSize: 12, fontWeight: "900", textAlign: "center", lineHeight: 18 },
  psbtText: { fontSize: 10, fontFamily: "monospace" },
  copyBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8 },
  copyBtnText: { fontSize: 12, fontWeight: "900" },
  doneBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  doneBtnText: { fontSize: 15, fontWeight: "900" },
});
