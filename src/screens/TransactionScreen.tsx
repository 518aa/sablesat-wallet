import AsyncStorage from "@react-native-async-storage/async-storage";
import { FlatList, Pressable, RefreshControl, StatusBar, StyleSheet, Text, View } from "react-native";
import { useCallback, useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { useBlockchain } from "../hooks/useBlockchain";
import { TransactionItem } from "../components/TransactionItem";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import type { ChainState } from "../services/blockchain";
import type { Language, ReturnTypeT } from "../i18n";
import { press } from "../theme-tokens";

const PAGE_SIZE = 15;
const HIDDEN_KEY = "bitnest.hiddenTxs";

type Tx = ChainState["transactions"][number];

type Props = {
  wallet: { address: string };
  titleLabel: string;
  emptyLabel: string;
  emptyHintLabel: string;
  loadingLabel: string;
  refreshHint: string;
  confirmedLabel: string;
  pendingLabel: string;
  loadMoreLabel: string;
  language: Language;
};

export function TransactionScreen({ titleLabel, emptyLabel, emptyHintLabel, loadingLabel, refreshHint, confirmedLabel, pendingLabel, loadMoreLabel, language }: Props) {
  const { theme } = useTheme();
  const { chain, price, busy, refresh } = useBlockchain();
  const [merged, setMerged] = useState<Tx[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [visible, setVisible] = useState(PAGE_SIZE);

  useEffect(() => {
    AsyncStorage.getItem(HIDDEN_KEY).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setHidden(parsed.filter((x) => typeof x === "string"));
        } catch { /* ignore */ }
      }
    }).catch(() => {});
  }, []);

  // 增量合并：链上返回的是最新在前，刷新后只会有“新交易”排在前面；
  // 被隐藏的 txid 始终排除，删除后刷新也不会再出现。
  useEffect(() => {
    const txs = chain?.transactions ?? [];
    const next = txs.filter((t) => !hidden.includes(t.txid));
    setMerged(next);
  }, [chain, hidden]);

  useEffect(() => {
    AsyncStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)).catch(() => {});
  }, [hidden]);

  const visibleTxs = merged.slice(0, visible);
  const hasMore = visible < merged.length;
  const initialLoading = busy && merged.length === 0;

  const handleLoadMore = useCallback(() => setVisible((v) => v + PAGE_SIZE), []);

  function handleDelete(txid: string) {
    setHidden((h) => (h.includes(txid) ? h : [...h, txid]));
  }

  const renderTx = ({ item: tx }: { item: Tx }) => (
    <View style={[styles.txRow, { borderColor: theme.border }]}>
      <TransactionItem
        txid={tx.txid}
        confirmed={tx.confirmed}
        valueSats={tx.valueSats}
        priceCny={price}
        time={tx.time}
        confirmedLabel={confirmedLabel}
        pendingLabel={pendingLabel}
        expandable={true}
        language={language}
      />
      <Pressable
        onPress={() => handleDelete(tx.txid)}
        accessibilityRole="button"
        accessibilityLabel="Delete transaction"
        hitSlop={8}
        style={({ pressed }) => [
          styles.deleteBtn,
          { backgroundColor: theme.surface, borderColor: theme.border },
          pressed && { opacity: 0.6, transform: [{ scale: press.scale }] },
        ]}
      >
        <Text style={[styles.deleteText, { color: theme.outgoing }]}>✕</Text>
      </Pressable>
    </View>
  );

  return (
    <FlatList
      data={visibleTxs}
      keyExtractor={(tx) => tx.txid}
      renderItem={renderTx}
      contentContainerStyle={[styles.container, { backgroundColor: theme.bg }]}
      refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={theme.accent} />}
      onEndReached={hasMore ? handleLoadMore : undefined}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={
        <>
          <Text style={[styles.title, { color: theme.text }]}>{titleLabel}</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{refreshHint}</Text>
        </>
      }
      ListEmptyComponent={
        initialLoading ? (
          <Spinner label={loadingLabel} />
        ) : merged.length === 0 ? (
          <EmptyState icon="⧗" title={emptyLabel} hint={emptyHintLabel} />
        ) : null
      }
      ListFooterComponent={hasMore ? (
        <Pressable
          onPress={handleLoadMore}
          accessibilityRole="button"
          accessibilityLabel={loadMoreLabel}
          style={({ pressed }) => [
            styles.loadMore,
            { backgroundColor: theme.card, borderColor: theme.border },
            pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
          ]}
        >
          <Text style={[styles.loadMoreText, { color: theme.accent }]}>{loadMoreLabel}</Text>
        </Pressable>
      ) : null}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 12, paddingBottom: 112, gap: 10 },
  title: { fontSize: 26, fontWeight: "900" },
  subtitle: { fontSize: 13, lineHeight: 19, marginBottom: 4 },
  emptyBox: { borderWidth: 1, borderRadius: 8, padding: 16 },
  empty: { fontSize: 13 },
  txRow: { position: "relative", borderWidth: 1, borderRadius: 10, overflow: "hidden" },
  deleteBtn: { position: "absolute", top: 8, right: 8, width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  deleteText: { fontSize: 12, fontWeight: "900" },
  loadMore: { minHeight: 46, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 4 },
  loadMoreText: { fontSize: 14, fontWeight: "900" },
});
