import { useState } from "react";
import { Alert, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { QrCode } from "../components/QrCode";
import { useTheme } from "../hooks/useTheme";
import { useVault } from "../hooks/useVault";
import { useVaults } from "../hooks/useVaults";
import type { ReturnTypeT } from "../i18n";
import { tnum } from "../theme-tokens";
import { logger } from "../services/logger";
import { buildVaultDescriptor } from "../services/vault/descriptor";

type Props = {
  vaultId: string;
  text: ReturnTypeT;
  onBack: () => void;
  onSend: () => void;
  onCosign: () => void;
};

export function VaultDetailScreen({ vaultId, text, onBack, onSend, onCosign }: Props) {
  const { theme } = useTheme();
  const { vault, receiveAddresses, totalSats, complete, loading, error, refresh } = useVault(vaultId);
  const { removeVault } = useVaults();
  const [showReceive, setShowReceive] = useState(false);

  const firstReceive = receiveAddresses[0]?.address ?? "";

  function formatBtc(sats: number) {
    return (sats / 1e8).toFixed(8);
  }

  function handleDelete() {
    // 未备份 descriptor 的金库禁止删除：删了就真找不回来了。
    // 旧文案说「重新搭建相同的多签配置即可花费」是错的 —— 重建不等于恢复。
    if (!vault?.descriptorBackedUp) {
      Alert.alert(text.vaultDeleteBlockedTitle, text.vaultDeleteBlockedBody, [
        { text: text.cancel, style: "cancel" },
        { text: text.vaultDescriptorTitle, onPress: showDescriptor },
      ]);
      return;
    }
    Alert.alert(text.vaultDeleteConfirmTitle, text.vaultDeleteConfirmBodyV2, [
      { text: text.cancel, style: "cancel" },
      {
        text: text.vaultDeleteConfirmAction,
        style: "destructive",
        onPress: async () => {
          try {
            await removeVault(vaultId);
            onBack();
          } catch (err) {
            logger.warn("Delete vault failed", err);
          }
        },
      },
    ]);
  }

  function showDescriptor() {
    if (!vault) return;
    try {
      Alert.alert(text.vaultDescriptorTitle, buildVaultDescriptor(vault).multipath);
    } catch (err) {
      logger.warn("Build descriptor failed", err);
    }
  }

  /**
   * 收款前跨设备核对引导。
   *
   * 多签的标准安全实践：收款前在**每一台** cosigner 设备上独立派生同一地址，
   * 肉眼比对一致后才使用。只在本机算一次是无效的——如果本机被攻破（比如添加
   * cosigner 时某个 xpub 被换成攻击者的），你会把钱收进一个攻击者能凑够 m 签
   * 的地址，而多签本来就是为了防单点被攻破。
   */
  function confirmReceiveAddress() {
    if (!vault) return;
    const idx = receiveAddresses[0]?.index ?? 0;
    Alert.alert(
      text.vaultVerifyAddressTitle,
      text.vaultVerifyAddressBody.replace("{index}", String(idx)),
      [
        { text: text.cancel, style: "cancel" },
        { text: text.confirm, onPress: () => setShowReceive(true) },
      ],
    );
  }

  if (!vault) {
    return (
      <View style={[styles.container, { backgroundColor: theme.bg }]}>
        <Text style={[styles.hint, { color: theme.textMuted }]}>{loading ? text.loading : error ?? ""}</Text>
      </View>
    );
  }

  if (showReceive && firstReceive) {
    return (
      <VaultReceiveView
        address={firstReceive}
        vaultName={vault.name}
        theme={theme}
        text={text}
        onClose={() => setShowReceive(false)}
      />
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.bg }]} contentContainerStyle={styles.body}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{text.vaultBackToList}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{vault.name}</Text>
        <View style={{ width: 64 }} />
      </View>

      <View style={[styles.balanceCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.balanceLabel, { color: theme.textSecondary }]}>{text.balance}</Text>
        <Text style={[styles.balanceValue, tnum, { color: theme.text }]}>{formatBtc(totalSats)}</Text>
        <Text style={[styles.balanceUnit, { color: theme.textMuted }]}>BTC</Text>
        {!complete && !loading && (
          // 部分地址没扫到时，上面这个数字是**下界**而不是真实余额。
          // 不提示的话用户只会看到一个每次刷新都不一样的数字，无从判断是行情还是故障。
          <Text style={{ color: theme.outgoing, fontSize: 12, fontWeight: "700", marginTop: 6, textAlign: "center" }}>
            {text.balanceIncomplete}
          </Text>
        )}
        <View style={[styles.thresholdRow, { borderColor: theme.border }]}>
          <Text style={[styles.thresholdText, { color: theme.textSecondary }]}>
            {text.vaultThresholdValue.replace("{m}", String(vault.m)).replace("{n}", String(vault.n))}
          </Text>
          <Pressable onPress={() => refresh()} style={[styles.refreshBtn, { backgroundColor: theme.surface }]}>
            <Text style={[styles.refreshBtnText, { color: theme.text }]}>{text.refresh}</Text>
          </Pressable>
        </View>
      </View>

      {error && <Text style={[styles.errorText, { color: theme.outgoing }]}>{error}</Text>}

      {!vault.descriptorBackedUp && (
        <Pressable
          onPress={showDescriptor}
          accessibilityRole="button"
          accessibilityLabel={text.vaultDescriptorTitle}
          style={[styles.warnCard, { backgroundColor: theme.card, borderColor: theme.outgoing }]}
        >
          <Text style={[styles.sectionTitle, { color: theme.outgoing }]}>
            ⚠ {text.vaultDescriptorTitle}
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>
            {text.vaultDescriptorBody}
          </Text>
        </Pressable>
      )}

      <Pressable
        onPress={() => firstReceive && confirmReceiveAddress()}
        disabled={!firstReceive}
        style={[styles.addressCard, { backgroundColor: theme.card, borderColor: theme.border, opacity: firstReceive ? 1 : 0.5 }]}
      >
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{text.vaultDetailReceive}</Text>
        <Text style={[styles.addressPreview, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="middle">
          {firstReceive || text.loading}
        </Text>
      </Pressable>

      <View style={styles.actionsRow}>
        <Pressable
          onPress={onSend}
          disabled={totalSats === 0}
          style={[styles.actionBtn, { backgroundColor: totalSats > 0 ? theme.primaryButton : theme.surface, opacity: totalSats > 0 ? 1 : 0.5 }]}
        >
          <Text style={[styles.actionBtnText, { color: totalSats > 0 ? theme.primaryButtonText : theme.textMuted }]}>
            {text.vaultDetailSend}
          </Text>
        </Pressable>
        <Pressable onPress={onCosign} style={[styles.actionBtn, { backgroundColor: theme.surface }]}>
          <Text style={[styles.actionBtnText, { color: theme.text }]}>{text.vaultDetailCosign}</Text>
        </Pressable>
      </View>

      <Pressable onPress={handleDelete} style={[styles.deleteBtn, { borderColor: theme.outgoing }]}>
        <Text style={[styles.deleteBtnText, { color: theme.outgoing }]}>{text.vaultDetailDelete}</Text>
      </Pressable>
    </ScrollView>
  );
}

function VaultReceiveView({
  address,
  vaultName,
  theme,
  text,
  onClose,
}: {
  address: string;
  vaultName: string;
  theme: import("../theme").Theme;
  text: ReturnTypeT;
  onClose: () => void;
}) {
  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={onClose} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{text.backToWallet}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{vaultName}</Text>
        <View style={{ width: 64 }} />
      </View>
      <View style={[styles.qrCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <QrCode value={address} size={220} centerLabel="₿" />
        <Text style={[styles.addressFull, { color: theme.text }]} selectable>{address}</Text>
        <Text style={[styles.receiveHint, { color: theme.textSecondary }]}>{text.receiveHint}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  warnCard: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 12 },
  container: { flex: 1, paddingTop: (StatusBar.currentHeight ?? 24) + 12 },
  body: { padding: 16, gap: 14, paddingBottom: 32 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  title: { fontSize: 17, fontWeight: "900", flexShrink: 1 },
  hint: { fontSize: 13, textAlign: "center", paddingTop: 24 },
  balanceCard: { padding: 18, borderRadius: 12, borderWidth: 1, gap: 4 },
  balanceLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  balanceValue: { fontSize: 30, fontWeight: "900" },
  balanceUnit: { fontSize: 12, fontWeight: "900" },
  thresholdRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, marginTop: 14, paddingTop: 12 },
  thresholdText: { fontSize: 11 },
  refreshBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 },
  refreshBtnText: { fontSize: 11, fontWeight: "900" },
  errorText: { fontSize: 12 },
  addressCard: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 4 },
  sectionTitle: { fontSize: 12, fontWeight: "900", letterSpacing: 0.4 },
  addressPreview: { fontSize: 13, fontFamily: "monospace" },
  actionsRow: { flexDirection: "row", gap: 10 },
  actionBtn: { flex: 1, minHeight: 50, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  actionBtnText: { fontSize: 13, fontWeight: "900" },
  deleteBtn: { paddingVertical: 14, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  deleteBtnText: { fontSize: 13, fontWeight: "900" },
  qrCard: { padding: 20, borderRadius: 12, borderWidth: 1, alignItems: "center", gap: 14, marginTop: 24 },
  addressFull: { fontSize: 12, fontFamily: "monospace", textAlign: "center" },
  receiveHint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
});
