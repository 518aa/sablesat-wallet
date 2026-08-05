import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
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
import { QrCode } from "../components/QrCode";
import { QrScanner } from "../components/QrScanner";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import { hapticImpact } from "../utils/haptics";
import { useVaults, type CosignerInput } from "../hooks/useVaults";
import {
  DuplicateCosignerError,
  normalizedKeyId,
  parseKeyExpression,
  selfKeyExpression,
} from "../services/vault/descriptor";
import { deriveVaultAddress } from "../services/vault/multisig";
import { isExtendedPrivateKey } from "../services/extkey";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  text: ReturnTypeT;
  onCreated: (vaultId: string) => void;
  onBack: () => void;
};

// 可选多签方案：m-of-n，self 占 1 把，其余为外部协签方。
const SCHEMES = [
  { key: "2of2", m: 2, external: 1, label: "2 / 2" },
  { key: "2of3", m: 2, external: 2, label: "2 / 3" },
  { key: "3of4", m: 3, external: 3, label: "3 / 4" },
  { key: "3of5", m: 3, external: 4, label: "3 / 5" },
] as const;

export function VaultCreateScreen({ text, onCreated, onBack }: Props) {
  const { theme } = useTheme();
  const { selfCosigner, createVault, markDescriptorBackedUp } = useVaults();
  const [name, setName] = useState("");
  const [schemeKey, setSchemeKey] = useState<string>("2of3");
  const scheme = SCHEMES.find((s) => s.key === schemeKey) ?? SCHEMES[1];
  const [cosignerInputs, setCosignerInputs] = useState<CosignerInput[]>(
    Array.from({ length: scheme.external }, (_, i) => ({ name: text.vaultCosignerDeviceName.replace("{n}", String(i + 2)), xpub: "" })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [scanIndex, setScanIndex] = useState<number | null>(null);
  const [navigating, setNavigating] = useState(false);

  function handleBack() {
    hapticImpact("light");
    setNavigating(true);
    requestAnimationFrame(() => onBack());
  }

  function selectScheme(key: string) {
    const s = SCHEMES.find((x) => x.key === key) ?? SCHEMES[1];
    setSchemeKey(key);
    setCosignerInputs((prev) =>
      Array.from({ length: s.external }, (_, i) =>
        prev[i] ?? { name: text.vaultCosignerDeviceName.replace("{n}", String(i + 2)), xpub: "" },
      ),
    );
  }

  const validationErrors = useMemo(() => {
    // 逐项：格式校验 + 与其他槽位（含 self）重复检测。
    // 重复 xpub 会让 2-of-3 静默退化成 1-of-2，必须在输入阶段就拦住。
    const ids = new Map<string, number>();
    const selfId = (() => {
      try {
        return selfCosigner ? normalizedKeyId(selfCosigner.xpub) : null;
      } catch {
        return null;
      }
    })();
    return cosignerInputs.map((c, i) => {
      const raw = c.xpub.trim();
      if (raw === "") return null;
      // 粘进来的是扩展**私钥** —— 单独给一条明确提示。它会被写进导出的
      // descriptor，而用户被要求把描述符打印/拍照备份。
      if (isExtendedPrivateKey(raw)) return text.vaultCosignerIsPrivateKey;
      let parsed;
      try {
        parsed = parseKeyExpression(raw);
      } catch {
        return text.vaultCosignerInvalid;
      }
      // 裸 xpub 缺 key origin：master fingerprint 推不出来，路径也无从得知。
      // 编一个出来会让导出的描述符与 PSBT 在对端全部失配。
      if (!parsed.fingerprint || !parsed.derivationPath) return text.vaultCosignerNeedsOrigin;
      let id: string;
      try {
        id = normalizedKeyId(parsed.xpub);
      } catch {
        return text.vaultCosignerInvalid;
      }
      if (id === selfId) return text.vaultDuplicateXpub;
      const seen = ids.get(id);
      if (seen !== undefined && seen !== i) return text.vaultDuplicateXpub;
      ids.set(id, i);
      return null;
    });
  }, [cosignerInputs, selfCosigner, text.vaultCosignerInvalid, text.vaultDuplicateXpub]);

  const previewAddress = useMemo(() => {
    if (!selfCosigner) return null;
    const parsedInputs = cosignerInputs
      .map((c) => {
        try {
          const p = parseKeyExpression(c.xpub);
          return p.fingerprint && p.derivationPath ? { input: c, parsed: p } : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (parsedInputs.length < scheme.external) return null;
    const external = parsedInputs.map(({ input, parsed }, i) => ({
      role: "external" as const,
      name: input.name || `Cosigner ${i + 2}`,
      xpub: parsed.xpub,
      // 用协签方**自己**的 origin，不再抄本机的。
      derivationPath: parsed.derivationPath!,
      fingerprint: parsed.fingerprint!,
    }));
    try {
      return deriveVaultAddress([selfCosigner, ...external], false, 0, scheme.m).address;
    } catch {
      return null;
    }
  }, [selfCosigner, cosignerInputs, scheme]);

  const canSubmit =
    !submitting &&
    Boolean(selfCosigner) &&
    cosignerInputs.length === scheme.external &&
    validationErrors.every((e) => e === null) &&
    cosignerInputs.every((c) => c.xpub.trim() !== "");

  // 复制**完整 key expression**（含 master fingerprint 与派生路径），不是裸 xpub。
  // 对端只拿到 xpub 时同样凑不出 key origin，问题在两台设备上是对称的。
  const selfExpression = useMemo(() => {
    if (!selfCosigner) return null;
    try {
      return selfKeyExpression(selfCosigner);
    } catch {
      return null;
    }
  }, [selfCosigner]);

  async function handleCopyXpub() {
    if (!selfExpression) return;
    await Clipboard.setStringAsync(selfExpression);
    Alert.alert(text.appName, text.vaultCopiedXpub);
  }

  async function handlePasteAt(idx: number) {
    const text = await Clipboard.getStringAsync();
    if (!text) return;
    setCosignerInputs((prev) => prev.map((c, i) => (i === idx ? { ...c, xpub: text.trim() } : c)));
  }

  function handleScannedXpub(data: string) {
    if (scanIndex === null) return;
    setCosignerInputs((prev) => prev.map((c, i) => (i === scanIndex ? { ...c, xpub: data.trim() } : c)));
    setScanIndex(null);
  }

  const [createdDescriptor, setCreatedDescriptor] = useState<{ vaultId: string; text: string } | null>(null);

  async function confirmDescriptorBackup() {
    if (!createdDescriptor) return;
    await markDescriptorBackedUp(createdDescriptor.vaultId);
    const id = createdDescriptor.vaultId;
    setCreatedDescriptor(null);
    Alert.alert(text.appName, text.vaultCreatedToast);
    onCreated(id);
  }

  async function handleSubmit() {
    if (!canSubmit || !selfCosigner) return;
    setSubmitting(true);
    try {
      const { vault, descriptor } = await createVault({ name, cosignerInputs, m: scheme.m });
      // 立刻把 output descriptor 交给用户备份。设备丢失后仅有助记词**无法**
      // 恢复多签资产——必须同时保留描述符。未确认备份前不显示收款地址。
      setCreatedDescriptor({ vaultId: vault.id, text: descriptor.multipath });
    } catch (err) {
      if (err instanceof DuplicateCosignerError) {
        Alert.alert(text.appName, text.vaultDuplicateXpub);
        return;
      }
      logger.warn("Vault create failed", err);
      Alert.alert(text.appName, err instanceof Error ? err.message : text.vaultCreateFailed);
    } finally {
      setSubmitting(false);
    }
  }

  if (!selfCosigner) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{text.loading}</Text>
      </View>
    );
  }

  if (createdDescriptor) {
    // 强制备份门禁：未确认备份 output descriptor 之前，不放行到金库详情页。
    // 设备丢失后仅有助记词**无法**恢复多签资产——必须同时保留这段描述符。
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 20 }}>
        <Text style={[styles.title, { color: theme.text }]}>{text.vaultDescriptorTitle}</Text>
        <Text style={[styles.hint, { color: theme.textSecondary, marginBottom: 16 }]}>
          {text.vaultDescriptorBody}
        </Text>
        <View style={[styles.descriptorBox, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text selectable style={[styles.descriptorText, { color: theme.text }]}>
            {createdDescriptor.text}
          </Text>
        </View>
        <View style={{ alignItems: "center", marginVertical: 16 }}>
          <QrCode value={createdDescriptor.text} size={220} />
        </View>
        <Pressable
          onPress={confirmDescriptorBackup}
          accessibilityRole="button"
          accessibilityLabel={text.vaultDescriptorConfirm}
          style={[styles.primaryBtn, { backgroundColor: theme.primaryButton }]}
        >
          <Text style={{ color: theme.primaryButtonText, fontWeight: "900" }}>
            {text.vaultDescriptorConfirm}
          </Text>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        {scanIndex !== null && (
          <QrScanner
            onScanned={handleScannedXpub}
            onClose={() => setScanIndex(null)}
            closeLabel={text.cancel}
            deniedTitle={text.vaultCosignCameraDeniedTitle}
            deniedBody={text.vaultCosignCameraDeniedBody}
            authorizeLabel={text.cameraAuthorize}
            scanHint={text.scanHint}
          />
        )}
        <View style={styles.header}>
          <Pressable onPress={handleBack} style={[styles.backButton, { backgroundColor: theme.surface }]}>
            <Text style={[styles.backText, { color: theme.text }]}>{text.vaultBackToList}</Text>
          </Pressable>
          <Text style={[styles.title, { color: theme.text }]}>{text.vaultCreateTitle}</Text>
          <View style={{ width: 64 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scrollBody}>
          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultSelfXpub}</Text>
            <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>{text.vaultSelfXpubHint}</Text>
            <View style={styles.qrWrap}>
              {/* QR 里同样是完整 key expression，对端扫码即可拿到 key origin。 */}
              <QrCode value={selfExpression ?? selfCosigner.xpub} size={200} centerLabel="₿" />
            </View>
            <Pressable onPress={handleCopyXpub} style={[styles.copyBtn, { backgroundColor: theme.surface }]}>
              <Text style={[styles.copyBtnText, { color: theme.text }]}>{text.copy}</Text>
            </Pressable>
            <Text style={[styles.fingerprint, { color: theme.textMuted }]}>
              {`${text.vaultSelfFingerprint}: ${selfCosigner.fingerprint.toUpperCase()}`}
            </Text>
          </View>

          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultThresholdLabel}</Text>
            <View style={styles.schemeRow}>
              {SCHEMES.map((s) => {
                const active = s.key === schemeKey;
                return (
                  <Pressable
                    key={s.key}
                    onPress={() => selectScheme(s.key)}
                    style={[styles.schemeChip, { backgroundColor: active ? theme.primaryButton : theme.surface, borderColor: active ? theme.primaryButton : theme.border }]}
                  >
                    <Text style={[styles.schemeChipText, { color: active ? theme.primaryButtonText : theme.text }]}>{s.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.thresholdValue, { color: theme.textSecondary }]}>
              {text.vaultThresholdValue.replace("{m}", String(scheme.m)).replace("{n}", String(scheme.external + 1))}
            </Text>
          </View>

          <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultNameLabel}</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={text.vaultNamePlaceholder}
              placeholderTextColor={theme.textMuted}
              style={[styles.textInput, { color: theme.text, borderColor: theme.inputBorder, backgroundColor: theme.input }]}
              autoCapitalize="none"
              autoCorrect={false}
            />

            {cosignerInputs.map((input, idx) => {
              const err = validationErrors[idx];
              return (
                <View key={idx} style={styles.cosignerBlock}>
                  <Text style={[styles.sectionTitle, { color: theme.text }]}>
                    {text.vaultCosignerLabel.replace("{n}", String(idx + 2))}
                  </Text>
                  <View style={[styles.xpubRow, { borderColor: theme.inputBorder, backgroundColor: theme.input }]}>
                    <TextInput
                      value={input.xpub}
                      onChangeText={(v) => setCosignerInputs((prev) => prev.map((c, i) => (i === idx ? { ...c, xpub: v } : c)))}
                      placeholder={text.vaultCosignerPlaceholder}
                      placeholderTextColor={theme.textMuted}
                      style={[styles.xpubInput, { color: theme.text }]}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                    />
                    <Pressable onPress={() => setScanIndex(idx)} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                      <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.vaultCosignScan}</Text>
                    </Pressable>
                    <Pressable onPress={() => handlePasteAt(idx)} style={[styles.pasteBtn, { backgroundColor: theme.surface }]}>
                      <Text style={[styles.pasteBtnText, { color: theme.text }]}>{text.vaultPaste}</Text>
                    </Pressable>
                  </View>
                  {err && <Text style={[styles.errorText, { color: theme.outgoing }]}>{err}</Text>}
                </View>
              );
            })}
          </View>

          {previewAddress && (
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultReviewAddress}</Text>
              <Text style={[styles.previewAddr, { color: theme.textSecondary }]}>{previewAddress}</Text>
              <Text style={[styles.sectionHint, { color: theme.textMuted }]}>{text.vaultReviewAddressHint}</Text>
            </View>
          )}

          <Pressable
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={[styles.submitBtn, { backgroundColor: canSubmit ? theme.primaryButton : theme.surface }]}
          >
            <Text style={[styles.submitBtnText, { color: canSubmit ? theme.primaryButtonText : theme.textMuted }]}>
              {submitting ? text.loading : text.vaultSaveAction}
            </Text>
          </Pressable>
          <LoadingOverlay visible={submitting} label={text.busyCreatingVault} />
        </ScrollView>
      </View>
      {navigating && (
        <View style={[styles.navOverlay, { backgroundColor: `${theme.bg}cc` }]}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  descriptorBox: { borderWidth: 1, borderRadius: 12, padding: 12 },
  descriptorText: { fontSize: 12, fontFamily: "Courier", lineHeight: 18 },
  primaryBtn: { paddingVertical: 16, borderRadius: 14, alignItems: "center", marginTop: 8 },
  container: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginBottom: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900" },
  scrollBody: { padding: 16, paddingTop: 4, gap: 14, paddingBottom: 32 },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 12 },
  sectionTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 0.4 },
  sectionHint: { fontSize: 12, lineHeight: 17 },
  qrWrap: { alignItems: "center", paddingVertical: 8 },
  copyBtn: { paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  copyBtnText: { fontSize: 12, fontWeight: "900" },
  fingerprint: { fontSize: 11, letterSpacing: 0.5, textAlign: "center", marginTop: 4 },
  textInput: { minHeight: 48, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 14 },
  cosignerBlock: { gap: 8 },
  xpubRow: { flexDirection: "row", borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, alignItems: "flex-end", gap: 6 },
  xpubInput: { flex: 1, minHeight: 60, fontSize: 11, fontFamily: "monospace", padding: 4 },
  pasteBtn: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 6 },
  pasteBtnText: { fontSize: 11, fontWeight: "900" },
  errorText: { fontSize: 11 },
  thresholdRow: { borderTopWidth: 1, paddingTop: 12, gap: 4 },
  thresholdValue: { fontSize: 12 },
  schemeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  schemeChip: { minWidth: 60, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  schemeChipText: { fontSize: 13, fontWeight: "900" },
  previewAddr: { fontSize: 11, fontFamily: "monospace", lineHeight: 16 },
  submitBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  submitBtnText: { fontSize: 15, fontWeight: "900" },
  hint: { fontSize: 13, textAlign: "center", paddingTop: 24 },
  navOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
