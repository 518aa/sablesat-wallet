import { ActivityIndicator, Alert, FlatList, Modal, Pressable, StatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../hooks/useTheme";
import { useVaults, VaultAlreadyExistsError, SelfNotInDescriptorError } from "../hooks/useVaults";
import { hapticImpact } from "../utils/haptics";
import { logger } from "../services/logger";
import type { ReturnTypeT } from "../i18n";
import type { VaultConfig } from "../services/vault/types";

type SortMode = "recent" | "name" | "threshold";

type Props = {
  text: ReturnTypeT;
  onCreate: () => void;
  onOpen: (vaultId: string) => void;
};

const SORT_LABELS: Record<SortMode, string> = { recent: "↻", name: "A↓", threshold: "m/n" };

function sortVaults(list: VaultConfig[], mode: SortMode): VaultConfig[] {
  const copy = [...list];
  switch (mode) {
    case "name":
      copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      break;
    case "threshold":
      copy.sort((a, b) => b.m - a.m || b.n - a.n || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      break;
    default:
      copy.sort((a, b) => b.createdAt - a.createdAt);
      break;
  }
  return copy;
}

export function VaultListScreen({ text, onCreate, onOpen }: Props) {
  const { theme } = useTheme();
  const { vaults, loading, error, selfCosigner, removeVault, importVaultFromDescriptor } = useVaults();
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [navigating, setNavigating] = useState(false);
  const [importVisible, setImportVisible] = useState(false);
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [importBusy, setImportBusy] = useState(false);

  const sorted = sortVaults(vaults, sortMode);

  const handleOpen = (vaultId: string) => {
    hapticImpact("light");
    setNavigating(true);
    requestAnimationFrame(() => onOpen(vaultId));
  };

  const cycleSort = () => {
    const idx = ["recent", "name", "threshold"].indexOf(sortMode);
    setSortMode((["recent", "name", "threshold"] as const)[(idx + 1) % 3]);
  };

  const handleDelete = (vault: VaultConfig) => {
    Alert.alert(text.vaultDeleteConfirmTitle, text.vaultDeleteConfirmBody, [
      { text: text.cancel, style: "cancel" },
      {
        text: text.vaultDeleteConfirmAction,
        style: "destructive",
        onPress: () => { hapticImpact("heavy"); void removeVault(vault.id); },
      },
    ]);
  };

  const handleImport = async () => {
    const trimmed = importText.trim();
    if (!trimmed) return;
    setImportBusy(true);
    try {
      const { vault } = await importVaultFromDescriptor(trimmed, importName.trim() || undefined);
      hapticImpact("heavy");
      setImportVisible(false);
      setImportText("");
      setImportName("");
      Alert.alert(text.vaultImportSuccess, `${vault.name} (${vault.m}/${vault.n})`);
    } catch (err) {
      if (err instanceof VaultAlreadyExistsError) {
        Alert.alert(text.vaultImportExists);
      } else if (err instanceof SelfNotInDescriptorError) {
        Alert.alert(text.vaultImportSelfNotIn, undefined, [
          { text: text.cancel, style: "cancel" },
          {
            text: text.vaultImportSelfNotInAction,
            onPress: async () => {
              try {
                await importVaultFromDescriptor(trimmed, importName.trim() || undefined);
                setImportVisible(false); setImportText(""); setImportName("");
              } catch { Alert.alert(text.vaultCreateFailed); }
            },
          },
        ]);
      } else {
        logger.warn("Import vault failed", err);
        Alert.alert(text.vaultImportInvalid);
      }
    } finally { setImportBusy(false); }
  };

  const renderVault = ({ item: vault }: { item: VaultConfig }) => (
    <Pressable
      onPress={() => handleOpen(vault.id)}
      accessibilityRole="button"
      accessibilityLabel={vault.name}
      style={[styles.vaultCard, { backgroundColor: theme.card, borderColor: theme.border }]}
    >
      <View style={styles.cardHeader}>
        <Text style={[styles.vaultName, { color: theme.text }]} numberOfLines={1}>{vault.name}</Text>
        <View style={styles.cardActions}>
          <View style={[styles.thresholdBadge, { backgroundColor: `${theme.accent}22` }]}>
            <Text style={[styles.thresholdText, { color: theme.accent }]}>{`${vault.m}/${vault.n}`}</Text>
          </View>
          <Pressable onPress={() => handleDelete(vault)} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="trash-outline" size={16} color={theme.dangerText} />
          </Pressable>
        </View>
      </View>
      <Text style={[styles.vaultMeta, { color: theme.textMuted }]}>
        {`${vault.cosigners.length} ${text.vaultReviewCosigners.toLowerCase()}`}
      </Text>
    </Pressable>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* Header row */}
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>{text.vaultTitle}</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={cycleSort} accessibilityRole="button" accessibilityLabel="sort" hitSlop={8}
            style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.chipText, { color: theme.textMuted }]}>{SORT_LABELS[sortMode]}</Text>
          </Pressable>
          <Pressable onPress={() => { hapticImpact("medium"); setImportVisible(true); }} accessibilityRole="button"
            accessibilityLabel={text.vaultImport}
            style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Ionicons name="download-outline" size={14} color={theme.textSecondary} style={{ marginRight: 4 }} />
            <Text style={[styles.chipText, { color: theme.textSecondary }]}>{text.vaultImport}</Text>
          </Pressable>
          <Pressable onPress={() => { hapticImpact("medium"); onCreate(); }} accessibilityRole="button"
            accessibilityLabel={text.vaultCreate}
            style={[styles.chip, { backgroundColor: theme.primaryButton }]}>
            <Ionicons name="add" size={16} color={theme.primaryButtonText} style={{ marginRight: 2 }} />
            <Text style={[styles.chipText, { color: theme.primaryButtonText, fontWeight: "800" }]}>{text.vaultCreate}</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={sorted}
        keyExtractor={(vault) => vault.id}
        renderItem={renderVault}
        ListEmptyComponent={
          loading ? <Text style={[styles.hint, { color: theme.textMuted }]}>{text.loading}</Text>
          : error ? <Text style={[styles.hint, { color: theme.outgoing }]}>{text.vaultListLoadFailed}</Text>
          : (
            <View style={[styles.emptyCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
              <Text style={[styles.emptyTitle, { color: theme.text }]}>{text.vaultEmpty}</Text>
              <Text style={[styles.emptyBody, { color: theme.textSecondary }]}>{text.vaultEmptyHint}</Text>
            </View>
          )
        }
        ListFooterComponent={
          !loading && selfCosigner && vaults.length > 0 ? (
            <Text style={[styles.footer, { color: theme.textMuted }]}>
              {`${text.vaultSelfFingerprint}: ${selfCosigner.fingerprint.toUpperCase()}`}
            </Text>
          ) : null
        }
      />
      {navigating && (
        <View style={[styles.navOverlay, { backgroundColor: `${theme.bg}cc` }]}>
          <ActivityIndicator size="large" color={theme.accent} />
        </View>
      )}

      {/* Import modal */}
      <Modal visible={importVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setImportVisible(false)}>
        <View style={[styles.modal, { backgroundColor: theme.bg }]}>
          <View style={styles.modalBar}>
            <Pressable onPress={() => setImportVisible(false)} hitSlop={12}>
              <Text style={[styles.modalCancel, { color: theme.accent }]}>{text.cancel}</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: theme.text }]}>{text.vaultImportTitle}</Text>
            <View style={{ width: 40 }} />
          </View>

          <Text style={[styles.importHint, { color: theme.textSecondary }]}>{text.vaultImportHint}</Text>

          <TextInput
            style={[styles.importTextarea, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
            placeholder={text.vaultImportPlaceholder}
            placeholderTextColor={theme.textMuted}
            value={importText} onChangeText={setImportText}
            multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false}
          />

          <Text style={[styles.label, { color: theme.textSecondary }]}>{text.vaultImportNameLabel}</Text>
          <TextInput
            style={[styles.importNameInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
            placeholder="Recovered Vault" placeholderTextColor={theme.textMuted}
            value={importName} onChangeText={setImportName} autoCapitalize="none" autoCorrect={false}
          />

          <Pressable onPress={handleImport} disabled={importBusy || !importText.trim()}
            style={[styles.btn, { backgroundColor: importText.trim() ? theme.primaryButton : theme.surface }]}>
            {importBusy
              ? <ActivityIndicator color={theme.primaryButtonText} />
              : <Text style={[styles.btnText, { color: importText.trim() ? theme.primaryButtonText : theme.textMuted }]}>{text.vaultImportAction}</Text>}
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  title: { fontSize: 22, fontWeight: "800", flexShrink: 1 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  chip: { flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 11, borderRadius: 9, borderWidth: 1, borderColor: "transparent" },
  chipText: { fontSize: 12, fontWeight: "700" },
  list: { gap: 12, paddingBottom: 32 },
  hint: { fontSize: 13, paddingVertical: 16, textAlign: "center" },
  emptyCard: { padding: 22, borderRadius: 10, borderWidth: 1, gap: 8 },
  emptyTitle: { fontSize: 16, fontWeight: "800" },
  emptyBody: { fontSize: 13, lineHeight: 19 },
  vaultCard: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 6 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  vaultName: { fontSize: 16, fontWeight: "800", flexShrink: 1 },
  cardActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  thresholdBadge: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6 },
  thresholdText: { fontSize: 11, fontWeight: "800" },
  vaultMeta: { fontSize: 12 },
  footer: { fontSize: 11, marginTop: 8, textAlign: "center", letterSpacing: 0.5 },
  navOverlay: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  // Modal
  modal: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12, paddingHorizontal: 20 },
  modalBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  modalCancel: { fontSize: 16 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  importHint: { fontSize: 13, lineHeight: 19, marginBottom: 16 },
  importTextarea: { minHeight: 130, borderRadius: 10, borderWidth: 1, padding: 14, fontSize: 13, fontFamily: "monospace", lineHeight: 20, marginBottom: 14 },
  label: { fontSize: 13, marginBottom: 8, fontWeight: "700" },
  importNameInput: { borderRadius: 10, borderWidth: 1, padding: 12, fontSize: 15, marginBottom: 24 },
  btn: { paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnText: { fontSize: 15, fontWeight: "800" },
});
