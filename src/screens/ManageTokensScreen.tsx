import { useEffect, useState } from "react";
import {
  ActivityIndicator,
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
import { useTheme } from "../hooks/useTheme";
import { EVM_CHAINS, type ChainId, type CustomToken, addCustomToken, removeCustomToken, loadCustomTokens } from "../chains/tokens";
import { fetchTokenMetadata } from "../services/evm";
import type { Language, ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  text: ReturnTypeT;
  language: Language;
  onClose: () => void;
};

type Preview = {
  name: string;
  symbol: string;
  decimals: number;
  contractAddress: string;
  chainId: ChainId;
};

export function ManageTokensScreen({ text, language, onClose }: Props) {
  const { theme } = useTheme();
  const [chainId, setChainId] = useState<ChainId>("bsc");
  const [address, setAddress] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState<CustomToken[]>([]);

  function reload() {
    void loadCustomTokens().then(setCustom);
  }
  useEffect(reload, []);

  async function handleLookup() {
    if (!address.trim()) return;
    setBusy(true);
    setPreview(null);
    try {
      const meta = await fetchTokenMetadata(chainId, address.trim());
      setPreview(meta);
    } catch (error) {
      logger.warn("Token metadata lookup failed", error);
      Alert.alert(text.appName, text.tokenLookupFailed);
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!preview) return;
    setBusy(true);
    try {
      const token: CustomToken = {
        id: `custom-${preview.chainId}-${preview.contractAddress.toLowerCase()}`,
        kind: "erc20",
        symbol: preview.symbol,
        name: preview.name,
        chainId: preview.chainId,
        contractAddress: preview.contractAddress,
        decimals: preview.decimals,
        feeSymbol: EVM_CHAINS[preview.chainId].feeSymbol,
        custom: true,
      };
      const next = await addCustomToken(token);
      setCustom(next);
      setAddress("");
      setPreview(null);
      Alert.alert(text.appName, text.tokenAdded);
    } catch (error) {
      logger.warn("Add token failed", error);
      Alert.alert(text.appName, text.tokenAddFailed);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    const next = await removeCustomToken(id);
    setCustom(next);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.flex, { backgroundColor: theme.bg }]}>
      <StatusBar barStyle={language === "zh" ? "dark-content" : "dark-content"} />
      <View style={[styles.topBar, { borderBottomColor: theme.border }]}>
        <Pressable onPress={onClose} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{text.backToWallet}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{text.manageTokens}</Text>
        <View style={styles.spacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.addTokenByAddress}</Text>
        <View style={styles.chainRow}>
          {(Object.keys(EVM_CHAINS) as ChainId[]).map((c) => {
            const active = chainId === c;
            return (
              <Pressable
                key={c}
                disabled={busy}
                onPress={() => setChainId(c)}
                style={[styles.chainChip, { backgroundColor: active ? `${theme.accent}22` : theme.surface, borderColor: active ? theme.accent : theme.border }]}
              >
                <Text style={[styles.chainChipText, { color: active ? theme.accent : theme.text }]}>{EVM_CHAINS[c].shortName}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            value={address}
            onChangeText={setAddress}
            placeholder={text.tokenAddressPlaceholder}
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { backgroundColor: theme.input, borderColor: theme.inputBorder, color: theme.text, flex: 1 }]}
          />
          <Pressable disabled={busy || !address.trim()} onPress={handleLookup} style={[styles.smallBtn, { backgroundColor: theme.secondaryButton }]}>
            {busy ? <ActivityIndicator color={theme.secondaryButtonText} /> : <Text style={{ color: theme.secondaryButtonText, fontWeight: "900", fontSize: 12 }}>{text.lookup}</Text>}
          </Pressable>
        </View>

        {preview && (
          <View style={[styles.preview, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>{text.tokenName}</Text>
              <Text style={[styles.previewValue, { color: theme.text }]}>{preview.name}</Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>{text.tokenSymbol}</Text>
              <Text style={[styles.previewValue, { color: theme.text }]}>{preview.symbol}</Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: theme.textSecondary }]}>{text.tokenDecimals}</Text>
              <Text style={[styles.previewValue, { color: theme.text }]}>{preview.decimals}</Text>
            </View>
            <Pressable disabled={busy} onPress={handleAdd} style={[styles.addConfirmBtn, { backgroundColor: theme.primaryButton }]}>
              <Text style={[styles.addConfirmText, { color: theme.primaryButtonText }]}>{text.addTokenConfirm}</Text>
            </Pressable>
          </View>
        )}

        <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 18 }]}>{text.customTokens}</Text>
        {custom.length === 0 && (
          <Text style={[styles.empty, { color: theme.textMuted }]}>{text.noCustomTokens}</Text>
        )}
        {custom.map((t) => (
          <View key={t.id} style={[styles.customRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={styles.customInfo}>
              <Text style={[styles.customName, { color: theme.text }]}>{t.name}</Text>
              <Text style={[styles.customMeta, { color: theme.textMuted }]}>{t.symbol} · {EVM_CHAINS[t.chainId as ChainId].shortName}</Text>
            </View>
            <Pressable onPress={() => handleRemove(t.id)} style={[styles.removeBtn, { borderColor: theme.outgoing }]}>
              <Text style={[styles.removeText, { color: theme.outgoing }]}>{text.remove}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 8, paddingBottom: 12, borderBottomWidth: 1 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  spacer: { width: 64 },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "900", marginTop: 4 },
  chainRow: { flexDirection: "row", gap: 8 },
  chainChip: { minWidth: 78, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  chainChipText: { fontSize: 13, fontWeight: "900" },
  inputRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  input: { minHeight: 48, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  smallBtn: { minHeight: 48, paddingHorizontal: 14, borderRadius: 8, justifyContent: "center" },
  preview: { borderRadius: 10, borderWidth: 1, padding: 14, gap: 8 },
  previewRow: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  previewLabel: { fontSize: 12, fontWeight: "700" },
  previewValue: { fontSize: 12, fontWeight: "900" },
  addConfirmBtn: { minHeight: 46, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 4 },
  addConfirmText: { fontWeight: "900", fontSize: 15 },
  customRow: { borderRadius: 10, borderWidth: 1, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  customInfo: { flex: 1, minWidth: 0 },
  customName: { fontSize: 14, fontWeight: "900" },
  customMeta: { fontSize: 11, marginTop: 4, fontWeight: "700" },
  removeBtn: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8 },
  removeText: { fontSize: 12, fontWeight: "900" },
  empty: { fontSize: 13, opacity: 0.8 },
});
