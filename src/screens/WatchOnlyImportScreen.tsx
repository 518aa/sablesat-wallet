import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import {
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
import { QrScanner } from "../components/QrScanner";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import { getNetworkModeSync } from "../services/network-mode";
import type { WatchOnlyConfig } from "../services/deviceRole";
import type { ReturnTypeT } from "../i18n";
import { parseExtKey } from "../services/extkey";
import { bytesToHex } from "../services/crypto";

function fingerprintHex(fp: number): string {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, fp >>> 0, false);
  return bytesToHex(bytes);
}

// 解析 zpub：成功返回 account 节点指纹 hex，失败返回 null。
// BIP84 account-level key depth must be 3 (m/purpose'/coin_type'/account').
function parseZpub(zpub: string): string | null {
  try {
    const account = parseExtKey(zpub.trim());
    if (!account.publicKey) return null;
    if (account.depth !== 3) return null; // 拒绝非 account 层级的扩展公钥
    if (account.fingerprint == null) return null;
    return fingerprintHex(account.fingerprint);
  } catch {
    return null;
  }
}

type Props = {
  text: ReturnTypeT;
  onSubmit: (cfg: WatchOnlyConfig) => Promise<void>;
  onBack: () => void;
};

export function WatchOnlyImportScreen({ text, onSubmit, onBack }: Props) {
  const { theme } = useTheme();
  const [name, setName] = useState("");
  const [zpub, setZpub] = useState("");
  const [busy, setBusy] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fingerprint = zpub.trim() ? parseZpub(zpub) : null;
  const canSubmit = !busy && fingerprint !== null;

  async function handlePaste() {
    const clip = await Clipboard.getStringAsync();
    setZpub(clip.trim());
  }

  async function handleSubmit() {
    if (!fingerprint) {
      setError(text.watchOnlyImportInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        schemaVersion: 1,
        name: name.trim() || "Watch-only",
        zpub: zpub.trim(),
        fingerprint,
        accountDerivation: getNetworkModeSync() === "testnet" ? "m/84'/1'/0'" : "m/84'/0'/0'",
        network: getNetworkModeSync(),
        createdAt: Date.now(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        {showScanner && (
          <QrScanner
            onScanned={(data) => {
              setZpub(data.trim());
              setShowScanner(false);
            }}
            onClose={() => setShowScanner(false)}
            closeLabel={text.cancel}
            deniedTitle={text.vaultCosignCameraDeniedTitle}
            deniedBody={text.vaultCosignCameraDeniedBody}
            authorizeLabel={text.cameraAuthorize}
            scanHint={text.scanHint}
          />
        )}
        <View style={styles.header}>
          <Pressable onPress={onBack} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.cancel}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.watchOnlyImportTitle}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.roleWatchOnlyHint}</Text>

            <Text style={[styles.label, { color: theme.text }]}>{text.watchOnlyImportNameLabel}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={text.watchOnlyImportNamePlaceholder}
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={[styles.label, { color: theme.text }]}>{text.watchOnlyImportZpubLabel}</Text>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.watchOnlyImportZpubHint}</Text>
            <View style={[styles.zpubRow, { borderColor: theme.inputBorder, backgroundColor: theme.input }]}>
              <TextInput
                value={zpub}
                onChangeText={setZpub}
                placeholder="zpub..."
                placeholderTextColor={theme.textMuted}
                style={[styles.zpubInput, { color: theme.text }]}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
              />
              <Pressable onPress={() => setShowScanner(true)} style={[styles.smallBtn, { backgroundColor: theme.surface }]}>
                <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.vaultCosignScan}</Text>
              </Pressable>
              <Pressable onPress={handlePaste} style={[styles.smallBtn, { backgroundColor: theme.surface }]}>
                <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.paste}</Text>
              </Pressable>
            </View>
            {zpub.trim() && !fingerprint && (
              <Text style={[styles.error, { color: theme.outgoing }]}>{text.watchOnlyImportInvalid}</Text>
            )}
            {fingerprint && (
              <Text style={[styles.fingerprint, { color: theme.textMuted }]}>
                {`${text.watchOnlyImportFingerprint}: ${fingerprint.toUpperCase()}`}
              </Text>
            )}
          </View>

          <Pressable
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={[styles.submitBtn, { backgroundColor: canSubmit ? theme.primaryButton : theme.surface }]}
          >
            <Text style={[styles.submitBtnText, { color: canSubmit ? theme.primaryButtonText : theme.textMuted }]}>
              {text.roleSelectAction}
            </Text>
          </Pressable>
          {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
        </ScrollView>
        <LoadingOverlay visible={busy} label={text.loading} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 10 },
  label: { fontSize: 13, fontWeight: "900" },
  hint: { fontSize: 12, lineHeight: 17 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  zpubRow: { flexDirection: "row", borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, alignItems: "flex-end", gap: 6 },
  zpubInput: { flex: 1, minHeight: 60, fontSize: 11, fontFamily: "monospace", padding: 4 },
  smallBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  smallBtnText: { fontSize: 11, fontWeight: "900" },
  fingerprint: { fontSize: 11, letterSpacing: 0.5 },
  submitBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 15, fontWeight: "900" },
  error: { fontSize: 12 },
});
