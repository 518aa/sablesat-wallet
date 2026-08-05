import { Image, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { hapticImpact } from "../utils/haptics";
import { ActionButtons } from "../components/ActionButtons";
import { BalanceCard } from "../components/BalanceCard";
import { TransactionItem } from "../components/TransactionItem";
import { Skeleton } from "../components/ui/Skeleton";
import { useBlockchain } from "../hooks/useBlockchain";
import { useAssets } from "../hooks/useAssets";
import { EVM_CHAINS, type ChainId } from "../chains/tokens";
import { ManageTokensScreen } from "./ManageTokensScreen";
import { useTheme } from "../hooks/useTheme";
import type { Language, ReturnTypeT } from "../i18n";
import { formatCny } from "../utils/format";
import { press } from "../theme-tokens";

type Props = {
  wallet: { address: string; evmAddress: string };
  language: Language;
  text: ReturnTypeT;
  onSend: () => void;
  onReceive: () => void;
  onHistory: () => void;
};

export function HomeScreen({ wallet, language, text, onSend, onReceive, onHistory }: Props) {
  const { theme } = useTheme();
  const { chain, price, busy, refresh } = useBlockchain();
  const { btc, groups, totalUsd, totalCny, rateCny, busy: assetsBusy, refresh: refreshAssets, reloadCustom } = useAssets(wallet.evmAddress);

  const [expanded, setExpanded] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);

  const recentTxs = (chain?.transactions ?? []).slice(0, 3);
  const btcValue = price ? formatCny((btc.balanceSats / 1e8) * price, language) : null;
  // First-load gate: while the blockchain store has no data yet, show skeletons
  // instead of a blank $0.00 and empty lists.
  const loading = !chain;

  async function refreshAll() {
    await Promise.all([refresh(), refreshAssets()]);
  }

  function closeManage() {
    setManageOpen(false);
    void reloadCustom(); // useEffect in useAssets will trigger refresh when custom state updates
  }

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.topBar}>
        <View style={[styles.brandMark, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Image source={require("../../assets/sablesat-icon.png")} style={styles.brandIcon} resizeMode="cover" />
        </View>
        <View style={styles.brandCopy}>
          <Text style={[styles.logoText, { color: theme.text }]}>{text.appName}</Text>
          <Text style={[styles.networkText, { color: theme.textMuted }]}>{text.network}</Text>
        </View>
        <Pressable
          onPress={() => { hapticImpact("light"); setManageOpen(true); }}
          accessibilityRole="button"
          accessibilityLabel={text.tokenAssets}
          style={({ pressed }) => [
            styles.addButton,
            { backgroundColor: theme.accent },
            pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
          ]}
        >
          <Text style={[styles.addText, { color: theme.primaryButtonText }]}>+</Text>
        </Pressable>
      </View>

      <BalanceCard
        balanceSats={btc.balanceSats}
        priceCny={price}
        btcUsd={btc.usd}
        totalUsd={totalUsd}
        totalCny={totalCny}
        assetLabel={text.tokenAssets}
        assetHint={text.tokenAssetsHint}
        busy={busy || assetsBusy}
        loading={loading}
        onRefresh={refreshAll}
        refreshingLabel={text.loading}
        refreshLabel={text.refresh}
        priceLabel={text.price}
        priceUnavailableLabel={text.priceUnavailable}
        language={language}
      />

      <ActionButtons
        onSend={onSend}
        onReceive={onReceive}
        sendLabel={text.send}
        receiveLabel={text.receive}
      />

      <View style={styles.assetList}>
        <Pressable
          onPress={() => { hapticImpact("light"); setExpanded((v) => !v); }}
          style={({ pressed }) => [
            styles.foldBar,
            { backgroundColor: theme.card, borderColor: theme.border },
            pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
          ]}
        >
          <Text style={[styles.foldTitle, { color: theme.text }]}>{text.assets}</Text>
          <Text style={[styles.foldArrow, { color: theme.textMuted }]}>{expanded ? "▲" : "▼"}</Text>
        </Pressable>

        {loading ? (
          <>
            <Skeleton width="100%" height={76} radius={10} />
            <Skeleton width="100%" height={76} radius={10} />
            <Skeleton width="100%" height={76} radius={10} />
          </>
        ) : (
          <>
            <AssetCard
              symbol="BTC"
              name="Bitcoin"
              meta={`BTC · ${text.network}`}
              balance={btc.display}
              fiat={btcValue ? `≈ ¥${btcValue}` : text.priceUnavailable}
              accent={theme.accent}
            />

            {expanded && groups.map((g) => (
              <View key={g.chain} style={styles.group}>
                <Text style={[styles.groupTitle, { color: theme.textSecondary }]}>{EVM_CHAINS[g.chain as ChainId].name}</Text>
                {g.assets.map((view) => (
                  <AssetCard
                    key={view.asset.id}
                    symbol={view.asset.symbol}
                    name={view.asset.name}
                    meta={`${view.asset.symbol} · ${EVM_CHAINS[g.chain as ChainId].shortName}`}
                    balance={view.displayBalance}
                    fiat={view.usd > 0 ? `≈ ¥${formatCny(view.usd * rateCny, language)}` : text.priceUnavailable}
                    accent={view.asset.symbol === "USDT" ? theme.incoming : theme.accent}
                  />
                ))}
              </View>
            ))}
            {expanded && groups.length === 0 && (
              <Text style={[styles.empty, { color: theme.textMuted }]}>{text.noTokens}</Text>
            )}
          </>
        )}
      </View>

      <View style={[styles.txPanel, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <View style={[styles.historyHeader, { borderBottomColor: theme.border }]}>
          <Text style={[styles.historyTitle, { color: theme.text }]}>{text.txHistory}</Text>
          <Pressable
          onPress={onHistory}
          style={({ pressed }) => [
            styles.historyIcon,
            { borderColor: theme.accent },
            pressed && { opacity: 0.6, transform: [{ scale: press.scale }] },
          ]}
        >
            <Text style={[styles.historyIconText, { color: theme.accent }]}>◷</Text>
          </Pressable>
        </View>
        {loading ? (
          <>
            <Skeleton width="100%" height={64} radius={10} />
            <Skeleton width="100%" height={64} radius={10} />
          </>
        ) : recentTxs.length === 0 ? (
          <Text style={[styles.empty, { color: theme.textMuted }]}>{text.noTxs}</Text>
        ) : (
          recentTxs.map((tx, index) => (
            <Pressable
              key={tx.txid}
              onPress={onHistory}
              style={index > 0 && [styles.txDivider, { borderTopColor: theme.border }]}
            >
              <TransactionItem
                txid={tx.txid}
                confirmed={tx.confirmed}
                valueSats={tx.valueSats}
                priceCny={price}
                time={tx.time}
                confirmedLabel={text.confirmed}
                pendingLabel={text.pending}
                compact
                language={language}
              />
            </Pressable>
          ))
        )}
      </View>

      <Modal visible={manageOpen} animationType="slide" onRequestClose={closeManage}>
        <ManageTokensScreen text={text} language={language} onClose={closeManage} />
      </Modal>
    </ScrollView>
  );
}

function AssetCard({ symbol, name, meta, balance, fiat, accent }: {
  symbol: string;
  name: string;
  meta: string;
  balance: string;
  fiat: string;
  accent: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={[styles.assetCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={[styles.assetIcon, { backgroundColor: `${accent}22`, borderColor: `${accent}55` }]}>
        <Text style={[styles.assetIconText, { color: accent }]}>{symbol === "BTC" ? "₿" : symbol === "USDT" ? "₮" : symbol.slice(0, 1)}</Text>
      </View>
      <View style={styles.assetInfo}>
        <Text style={[styles.assetName, { color: theme.text }]}>{name}</Text>
        <Text style={[styles.assetMeta, { color: theme.textMuted }]}>{meta}</Text>
      </View>
      <View style={styles.assetAmount}>
        <Text style={[styles.assetBtc, { color: theme.text }]}>{balance}</Text>
        <Text style={[styles.assetCny, { color: theme.textMuted }]}>{fiat}</Text>
      </View>
      <Text style={[styles.assetArrow, { color: theme.textMuted }]}>›</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 12, paddingBottom: 180, gap: 12 },
  topBar: { minHeight: 50, flexDirection: "row", alignItems: "center", gap: 12 },
  brandMark: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 }
  },
  brandIcon: { width: "100%", height: "100%" },
  brandCopy: { flex: 1 },
  logoText: { fontSize: 23, fontWeight: "800", letterSpacing: 0 },
  networkText: { fontSize: 11, fontWeight: "500", marginTop: 3 },
  addButton: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  addText: { fontSize: 28, fontWeight: "900", lineHeight: 30 },
  assetList: { gap: 8 },
  foldBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12 },
  foldTitle: { fontSize: 15, fontWeight: "800" },
  foldArrow: { fontSize: 14, fontWeight: "900" },
  group: { gap: 8, marginTop: 4 },
  groupTitle: { fontSize: 12, fontWeight: "800", marginLeft: 4, marginTop: 4 },
  assetCard: {
    borderWidth: 1,
    borderRadius: 10,
    minHeight: 76,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginTop: 2
  },
  assetIcon: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  assetIconText: { fontSize: 22, fontWeight: "900" },
  assetInfo: { flex: 1, minWidth: 0 },
  assetName: { fontSize: 15, fontWeight: "800" },
  assetMeta: { fontSize: 11, marginTop: 4, fontWeight: "500" },
  assetAmount: { alignItems: "flex-end", maxWidth: 138 },
  assetBtc: { fontSize: 12, fontWeight: "800" },
  assetCny: { fontSize: 11, marginTop: 4, textAlign: "right" },
  assetArrow: { fontSize: 28, fontWeight: "300", marginLeft: 2 },
  txPanel: { borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  historyHeader: { minHeight: 52, borderBottomWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyTitle: { fontSize: 17, fontWeight: "800" },
  historyIcon: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  historyIconText: { fontSize: 16, fontWeight: "900" },
  txDivider: { borderTopWidth: 1 },
  empty: { padding: 16, fontSize: 13 }
});
