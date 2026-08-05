import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import { Alert, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { QrCode } from "../components/QrCode";
import { useTheme } from "../hooks/useTheme";
import { deriveWatchAddresses } from "../services/watchOnly";
import type { WatchOnlyConfig } from "../services/deviceRole";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  text: ReturnTypeT;
  watchOnly: WatchOnlyConfig;
  onBack: () => void;
};

// 观察钱包收款页：从 zpub 派生首个收款地址，展示二维码 + 地址 + 复制 + 提示。
// 与热钱包收款页风格一致，但只展示 BTC（观察钱包只持公钥，无私钥/无 EVM）。
export function WatchOnlyReceiveScreen({ text, watchOnly, onBack }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const address = useMemo(() => {
    try {
      const list = deriveWatchAddresses(watchOnly.zpub, 1, false);
      return list[0] ?? "";
    } catch (e) {
      logger.warn("derive receive address failed", e);
      return "";
    }
  }, [watchOnly.zpub]);

  async function handleCopy() {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setCopied(true);
    Alert.alert(text.appName, text.copied);
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { marginTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{text.backToWallet}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{text.watchOnlyReceive}</Text>
        <View style={{ width: 64 }} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={styles.cardHeader}>
          <Text style={[styles.walletLabel, { color: theme.text }]}>Bitcoin</Text>
          <View style={[styles.primaryBadge, { backgroundColor: `${theme.accent}20` }]}>
            <Text style={[styles.primaryBadgeText, { color: theme.accent }]}>BTC</Text>
          </View>
        </View>

        {address ? (
          <View style={styles.qrWrap}><QrCode value={address} size={200} /></View>
        ) : (
          <Text style={[styles.error, { color: theme.outgoing }]}>{text.watchOnlyImportInvalid}</Text>
        )}

        <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.watchOnlyReceiveHint}</Text>
        <Pressable
          onPress={handleCopy}
          style={[styles.addressBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}
        >
          <Text style={[styles.address, { color: theme.text }]} selectable>{address}</Text>
          <Text style={[styles.copyMini, { color: theme.textMuted }]}>{text.copy}</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={handleCopy}
        style={[styles.copyBtn, { backgroundColor: copied ? theme.incoming : theme.primaryButton }]}
      >
        <Text style={[styles.copyText, { color: theme.primaryButtonText }]}>
          {copied ? text.copied : text.copyAddress}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 14 },
  header: { height: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  card: { padding: 16, borderRadius: 8, borderWidth: 1, gap: 14 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  walletLabel: { fontSize: 14, fontWeight: "900" },
  primaryBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  primaryBadgeText: { fontSize: 10, fontWeight: "900" },
  qrWrap: { alignSelf: "center", paddingVertical: 4 },
  hint: { fontSize: 12, lineHeight: 18 },
  addressBox: { borderWidth: 1, borderRadius: 8, padding: 13, flexDirection: "row", alignItems: "center", gap: 8 },
  address: { flex: 1, fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
  copyMini: { fontSize: 10, fontWeight: "900" },
  copyBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: "auto" },
  copyText: { fontWeight: "900", fontSize: 15 },
  error: { fontSize: 12 },
});
