import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { useTheme } from "../hooks/useTheme";
import {
  deriveWatchAddresses,
  fetchWatchBalanceSats,
  fetchWatchTransactions,
  watchTxExplorerUrl,
  type WatchTx,
} from "../services/watchOnly";
import { fetchBtcCnyPrice } from "../services/blockchain";
import { formatCny } from "../utils/format";
import { satsToBtc, SATS_PER_BTC } from "../utils/bitcoin";
import type { WatchOnlyConfig } from "../services/deviceRole";
import type { ReturnTypeT, Language } from "../i18n";
import { tnum } from "../theme-tokens";
import { logger } from "../services/logger";

type Props = {
  text: ReturnTypeT;
  language?: Language;
  watchOnly: WatchOnlyConfig;
  onReceive: () => void;
  onSend: () => void;
  onLock: () => void;
  onSwitchRole: () => void;
};

export function WatchOnlyHomeScreen({
  text,
  language = "zh",
  watchOnly,
  onReceive,
  onSend,
  onLock,
  onSwitchRole,
}: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [balance, setBalance] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [txs, setTxs] = useState<WatchTx[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // 派生收款地址用于展示。render 期执行，try/catch 防止解析失败炸整屏。
  const addresses = useMemo(() => {
    try {
      return deriveWatchAddresses(watchOnly.zpub, 3, false);
    } catch (e) {
      logger.warn("deriveWatchAddresses failed in render", e);
      return [];
    }
  }, [watchOnly.zpub]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setLoadError(false);
    try {
      const [balanceSats, priceCny, recentTxs] = await Promise.all([
        fetchWatchBalanceSats(watchOnly.zpub),
        fetchBtcCnyPrice().catch(() => null),
        fetchWatchTransactions(watchOnly.zpub).catch(() => [] as WatchTx[]),
      ]);
      setBalance(balanceSats);
      setPrice(priceCny);
      setTxs(recentTxs);
    } catch (e) {
      logger.warn("watch refresh failed", e);
      setLoadError(true);
    } finally {
      setRefreshing(false);
    }
  }, [watchOnly.zpub]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function handleExit() {
    Alert.alert(text.watchOnlyExitTitle, text.watchOnlyExitBody, [
      { text: text.watchOnlyExitLock, onPress: onLock },
      { text: text.watchOnlyExitSwitch, style: "destructive", onPress: onSwitchRole },
      { text: text.cancel, style: "cancel" },
    ]);
  }

  function openTx(txid: string) {
    void Linking.openURL(watchTxExplorerUrl(txid)).catch((e) => {
      logger.warn("open explorer failed", e);
      Alert.alert(text.appName, text.watchOnlyTxOpenExplorer);
    });
  }

  const balanceBtc = balance !== null ? satsToBtc(balance) : "...";
  const fiatValue = balance !== null && price ? formatCny((balance / SATS_PER_BTC) * price, language) : null;

  return (
    <ScrollView
      contentContainerStyle={[styles.container, { backgroundColor: theme.bg, paddingTop: insets.top + 12 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.accent} />}
    >
      {/* 余额卡 */}
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.textSecondary }]}>{text.watchOnlyBalanceLabel}</Text>
        <Text style={[styles.balance, tnum, { color: theme.text }]}>{balanceBtc}</Text>
        <Text style={[styles.unit, { color: theme.textMuted }]}>BTC</Text>
        {fiatValue && <Text style={[styles.fiatValue, tnum, { color: theme.textSecondary }]}>≈ ¥{fiatValue}</Text>}
        {price && (
          <View style={[styles.pricePill, { backgroundColor: `${theme.incoming}16`, borderColor: `${theme.incoming}42` }]}>
            <Text style={[styles.priceText, tnum, { color: theme.incoming }]}>BTC ¥{formatCny(price, language)}</Text>
          </View>
        )}
        <Text style={[styles.name, { color: theme.textSecondary }]}>{watchOnly.name}</Text>
        <Text style={[styles.fingerprint, { color: theme.textMuted }]}>
          {`${text.watchOnlyImportFingerprint}: ${(watchOnly.fingerprint ?? "").toUpperCase()}`}
        </Text>
        {loadError && (
          <Text style={[styles.errorText, { color: theme.outgoing }]}>{text.priceUnavailable}</Text>
        )}
      </View>

      {/* 收款 / 转账 两按钮 */}
      <View style={styles.actionRow}>
        <Pressable onPress={onReceive} style={[styles.actionBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.actionIcon, { color: theme.incoming }]}>↓</Text>
          <Text style={[styles.actionText, { color: theme.text }]}>{text.watchOnlyReceive}</Text>
        </Pressable>
        <Pressable onPress={onSend} style={[styles.actionBtn, { backgroundColor: theme.primaryButton }]}>
          <Text style={[styles.actionIcon, { color: theme.primaryButtonText }]}>↑</Text>
          <Text style={[styles.actionText, { color: theme.primaryButtonText }]}>{text.send}</Text>
        </Pressable>
      </View>

      {/* 派生地址说明 */}
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.cardTitle, { color: theme.text }]}>{text.watchOnlyDerivedTitle}</Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>{text.watchOnlyDerivedHint}</Text>
        {addresses.map((addr, i) => (
          <Text key={i} style={[styles.address, { color: theme.text }]} selectable>
            {`${i}  ${addr}`}
          </Text>
        ))}
      </View>

      {/* 交易列表 */}
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.cardTitle, { color: theme.text }]}>{text.watchOnlyTxHistory}</Text>
        {txs.length === 0 ? (
          <Text style={[styles.emptyText, { color: theme.textMuted }]}>{text.watchOnlyNoTxs}</Text>
        ) : (
          txs.map((tx) => {
            const incoming = tx.valueSats >= 0;
            return (
              <Pressable
                key={tx.txid}
                onPress={() => openTx(tx.txid)}
                style={[styles.txRow, { borderColor: theme.border }]}
              >
                <View style={styles.txLeft}>
                  <Text style={[styles.txDir, tnum, { color: incoming ? theme.incoming : theme.outgoing }]}>
                    {incoming ? "↓ " : "↑ "}
                    {satsToBtc(Math.abs(tx.valueSats))}
                  </Text>
                  <Text style={[styles.txStatus, { color: tx.confirmed ? theme.textMuted : theme.accent }]}>
                    {tx.confirmed ? text.confirmed : text.pending}
                  </Text>
                  {tx.time && (
                    <Text style={[styles.txTime, { color: theme.textMuted }]}>
                      {new Date(tx.time * 1000).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  )}
                </View>
                <Text style={[styles.txidMini, { color: theme.textMuted }]} numberOfLines={1}>
                  {tx.txid.slice(0, 10)}…{tx.txid.slice(-6)}
                </Text>
              </Pressable>
            );
          })
        )}
      </View>

      {/* 退出观察钱包 */}
      <Pressable
        onPress={handleExit}
        style={[styles.exitBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <Text style={[styles.exitText, { color: theme.outgoing }]}>{text.watchOnlyExit}</Text>
      </Pressable>

      <LoadingOverlay visible={refreshing && txs.length === 0 && balance === null} label={text.busyRefreshing} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 14, paddingBottom: 40 },
  card: { padding: 16, borderRadius: 10, borderWidth: 1, gap: 6 },
  label: { fontSize: 11, fontWeight: "900", letterSpacing: 0.4 },
  balance: { fontSize: 30, fontWeight: "900" },
  unit: { fontSize: 12, fontWeight: "900" },
  fiatValue: { fontSize: 14, fontWeight: "800", marginTop: 4 },
  pricePill: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7, alignSelf: "flex-start", marginTop: 8 },
  priceText: { fontSize: 12, fontWeight: "900" },
  name: { fontSize: 13, fontWeight: "800", marginTop: 8 },
  fingerprint: { fontSize: 11, fontFamily: "monospace" },
  errorText: { fontSize: 12, marginTop: 6 },
  actionRow: { flexDirection: "row", gap: 12 },
  actionBtn: { flex: 1, minHeight: 64, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  actionIcon: { fontSize: 20, fontWeight: "900" },
  actionText: { fontSize: 14, fontWeight: "900" },
  cardTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 0.3, marginBottom: 4 },
  hint: { fontSize: 12, lineHeight: 17, marginBottom: 6 },
  address: { fontSize: 11, fontFamily: "monospace", paddingVertical: 3 },
  emptyText: { fontSize: 12, paddingVertical: 8 },
  txRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10, borderBottomWidth: 1 },
  txLeft: { gap: 2 },
  txDir: { fontSize: 13, fontWeight: "900", fontFamily: "monospace" },
  txStatus: { fontSize: 10, fontWeight: "800" },
  txTime: { fontSize: 10, marginTop: 2 },
  txidMini: { fontSize: 10, fontFamily: "monospace", maxWidth: 120 },
  exitBtn: { minHeight: 48, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 4 },
  exitText: { fontSize: 13, fontWeight: "900" },
});
