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
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PinDialog } from "../components/PinDialog";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { generateMnemonic, isValidMnemonic } from "../services/wallet";
import { useTheme } from "../hooks/useTheme";
import type { ReturnTypeT } from "../i18n";

type Props = {
  text: ReturnTypeT;
  // 提交：助记词 + PIN + 终端别名。PIN 由本屏内置 PinDialog 收集（set + confirm）。
  onSubmit: (mnemonic: string, pin: string, label: string) => Promise<void>;
  onBack: () => void;
};

// 离线签名终端首次进入：先在「生成冷钱包 / 导入冷钱包」之间选择。
// 生成：现场产生 24 词助记词并强制抄写备份，再设 PIN。
// 导入：粘贴已有助记词，再设 PIN。
export function SigningTerminalSetupScreen({ text, onSubmit, onBack }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<"generate" | "import">("generate");
  const [label, setLabel] = useState("");
  const [importedMnemonic, setImportedMnemonic] = useState("");
  const [generatedMnemonic, setGeneratedMnemonic] = useState<string>(() => generateMnemonic());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinStep, setPinStep] = useState<"idle" | "set" | "confirm">("idle");
  const [pinValue, setPinValue] = useState("");
  const [pinError, setPinError] = useState("");

  const activeMnemonic = mode === "generate" ? generatedMnemonic : importedMnemonic.trim();
  const importValid = useMemo(() => {
    const m = importedMnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    return m.length > 0 && isValidMnemonic(m);
  }, [importedMnemonic]);
  const canSubmit = !busy && (mode === "generate" ? true : importValid);

  async function handlePasteMnemonic() {
    const clip = await Clipboard.getStringAsync();
    if (clip) setImportedMnemonic(clip.trim());
  }

  function startPinFlow() {
    if (!canSubmit) return;
    setError(null);
    setPinStep("set");
    setPinValue("");
    setPinError("");
  }

  async function handlePin(pin: string) {
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
    setPinStep("idle");
    setBusy(true);
    try {
      await onSubmit(activeMnemonic, pin, label.trim() || "Signing terminal");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <View style={[styles.header, { marginTop: insets.top + 8 }]}>
          <Pressable onPress={onBack} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.cancel}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.roleSigningTerminal}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {/* 模式切换 */}
          <View style={styles.modeRow}>
            <Pressable
              onPress={() => { setMode("generate"); setError(null); }}
              style={[styles.modeBtn, { backgroundColor: mode === "generate" ? theme.primaryButton : theme.surface, borderColor: mode === "generate" ? theme.primaryButton : theme.border }]}
            >
              <Text style={[styles.modeBtnText, { color: mode === "generate" ? theme.primaryButtonText : theme.text }]}>{text.coldWalletGenerate}</Text>
            </Pressable>
            <Pressable
              onPress={() => { setMode("import"); setError(null); }}
              style={[styles.modeBtn, { backgroundColor: mode === "import" ? theme.primaryButton : theme.surface, borderColor: mode === "import" ? theme.primaryButton : theme.border }]}
            >
              <Text style={[styles.modeBtnText, { color: mode === "import" ? theme.primaryButtonText : theme.text }]}>{text.signTerminalImportMode}</Text>
            </Pressable>
          </View>

          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.roleSigningTerminalHint}</Text>

            <Text style={[styles.label, { color: theme.text }]}>{text.watchOnlyImportNameLabel}</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder={text.watchOnlyImportNamePlaceholder}
              placeholderTextColor={theme.textMuted}
              style={[styles.input, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {mode === "generate" ? (
              <>
                <Text style={[styles.label, { color: theme.text }]}>{text.coldWalletMnemonicTitle}</Text>
                <Text style={[styles.warn, { color: theme.outgoing }]}>{text.coldWalletWarning}</Text>
                <Text style={[styles.mnemonicBox, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]} selectable>{generatedMnemonic}</Text>
                <Pressable onPress={() => setGeneratedMnemonic(generateMnemonic())} style={[styles.smallBtn, { backgroundColor: theme.surface, alignSelf: "flex-start" }]}>
                  <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.signTerminalRegenerate}</Text>
                </Pressable>
                <Pressable
                  onPress={startPinFlow}
                  style={[styles.submitBtn, { backgroundColor: theme.primaryButton }]}
                >
                  <Text style={[styles.submitBtnText, { color: theme.primaryButtonText }]}>{text.signTerminalBackupDone}</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: theme.text, flex: 1 }]}>{text.importTitle}</Text>
                  <Pressable onPress={handlePasteMnemonic} style={[styles.smallBtn, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.smallBtnText, { color: theme.text }]}>{text.paste}</Text>
                  </Pressable>
                </View>
                <TextInput
                  value={importedMnemonic}
                  onChangeText={setImportedMnemonic}
                  placeholder={text.importPlaceholder}
                  placeholderTextColor={theme.textMuted}
                  style={[styles.mnemonicInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                {importedMnemonic.trim() && !importValid && (
                  <Text style={[styles.error, { color: theme.outgoing }]}>{text.invalidMnemonic}</Text>
                )}
                <Pressable
                  disabled={!canSubmit}
                  onPress={startPinFlow}
                  style={[styles.submitBtn, { backgroundColor: canSubmit ? theme.primaryButton : theme.surface }]}
                >
                  <Text style={[styles.submitBtnText, { color: canSubmit ? theme.primaryButtonText : theme.textMuted }]}>
                    {text.roleSelectAction}
                  </Text>
                </Pressable>
              </>
            )}
            {error && <Text style={[styles.error, { color: theme.outgoing }]}>{error}</Text>}
          </View>
        </ScrollView>

        <PinDialog
          visible={pinStep !== "idle"}
          title={pinStep === "set" ? text.pinSetupTitle : text.pinSetupConfirm}
          subtitle={pinStep === "set" ? text.pinSetupSubtitle : undefined}
          errorText={pinError || undefined}
          cancelLabel={text.cancel}
          onPinEntered={handlePin}
          onCancel={() => {
            setPinStep("idle");
            setPinError("");
          }}
        />
        <LoadingOverlay visible={busy} label={text.busyImportingWallet} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  modeRow: { flexDirection: "row", gap: 10 },
  modeBtn: { flex: 1, minHeight: 48, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  modeBtnText: { fontSize: 13, fontWeight: "900" },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 10 },
  label: { fontSize: 13, fontWeight: "900" },
  hint: { fontSize: 12, lineHeight: 17 },
  warn: { fontSize: 12, lineHeight: 17, fontWeight: "700" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  mnemonicInput: { minHeight: 96, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 13, fontFamily: "monospace", textAlignVertical: "top" },
  mnemonicBox: { fontSize: 13, fontFamily: "monospace", borderWidth: 1, borderRadius: 8, padding: 12, lineHeight: 20 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  smallBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  smallBtnText: { fontSize: 11, fontWeight: "900" },
  submitBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 15, fontWeight: "900" },
  error: { fontSize: 12 },
});
