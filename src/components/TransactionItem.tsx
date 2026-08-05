import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { formatCny } from "../utils/format";
import type { Language, ReturnTypeT } from "../i18n";
import { satsToBtc, SATS_PER_BTC } from "../utils/bitcoin";
import { getNetworkModeSync } from "../services/network-mode";
import { tnum } from "../theme-tokens";
import { logger } from "../services/logger";

function TransactionItemComponent({
  txid,
  confirmed,
  valueSats,
  priceCny,
  time,
  confirmedLabel = "Confirmed",
  pendingLabel = "Pending",
  compact = false,
  expandable = false,
  onPress,
  language = "zh",
  text
}: {
  txid: string;
  confirmed: boolean;
  valueSats: number;
  priceCny: number | null;
  time?: number;
  confirmedLabel?: string;
  pendingLabel?: string;
  compact?: boolean;
  expandable?: boolean;
  onPress?: () => void;
  language?: Language;
  text?: ReturnTypeT;
}) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const isPositive = valueSats >= 0;
  const btc = satsToBtc(Math.abs(valueSats));
  const shortId = `${txid.slice(0, 8)}...${txid.slice(-8)}`;
  const cny = priceCny ? `≈ ¥${formatCny((Math.abs(valueSats) / SATS_PER_BTC) * priceCny, language, 0)}` : "--";
  const tone = isPositive ? theme.incoming : theme.outgoing;
  const timeText = time
    ? new Date(time * 1000).toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      })
    : null;

  const networkMode = getNetworkModeSync();
  const explorerUrl = networkMode === "testnet" 
    ? `https://mempool.space/testnet/tx/${txid}`
    : `https://mempool.space/tx/${txid}`;

  function handlePress() {
    if (onPress) {
      onPress();
    } else if (expandable) {
      setExpanded(!expanded);
    }
  }

  function handleOpenExplorer() {
    Linking.openURL(explorerUrl).catch((err) => {
      logger.warn("Failed to open explorer", err);
    });
  }

  return (
    <Pressable 
      onPress={handlePress}
      style={[
        styles.row, 
        compact ? styles.compactRow : { backgroundColor: theme.card, borderColor: theme.border },
        expandable && styles.pressable
      ]}
    >
      <View style={styles.mainRow}>
        <View style={[styles.icon, { backgroundColor: `${tone}22` }]}>
          <Text style={[styles.iconText, { color: tone }]}>{isPositive ? "IN" : "OUT"}</Text>
        </View>
        <View style={styles.info}>
          <Text style={[styles.hash, { color: theme.text }]} numberOfLines={1}>{shortId}</Text>
          <Text style={[styles.status, { color: confirmed ? theme.incoming : theme.warning }]}>
            {confirmed ? confirmedLabel : pendingLabel}
          </Text>
          {timeText && <Text style={[styles.time, { color: theme.textMuted }]}>{timeText}</Text>}
        </View>
        <View style={styles.amounts}>
          <Text style={[styles.amount, tnum, { color: tone }]}>
            {isPositive ? "+" : "-"}{btc}
          </Text>
          <Text style={[styles.cny, tnum, { color: theme.textMuted }]}>{cny}</Text>
        </View>
        {expandable && (
          <Text style={[styles.expandIcon, { color: theme.textMuted }]}>
            {expanded ? "▼" : "▶"}
          </Text>
        )}
      </View>
      
      {expanded && expandable && (
        <View style={[styles.expandedContent, { borderTopColor: theme.border }]}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>
              {text?.txDetailHash || (language === "zh" ? "交易哈希" : "Transaction ID")}
            </Text>
            <Text style={[styles.detailValue, { color: theme.text }]} selectable>
              {txid}
            </Text>
          </View>
          
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>
              {text?.txDetailAmount || (language === "zh" ? "金额" : "Amount")}
            </Text>
            <Text style={[styles.detailValue, tnum, { color: tone }]}>
              {isPositive ? "+" : "-"}{btc} BTC
            </Text>
          </View>
          
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>
              {text?.txDetailValue || (language === "zh" ? "等值" : "Value")}
            </Text>
            <Text style={[styles.detailValue, { color: theme.text }]}>
              {cny}
            </Text>
          </View>
          
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>
              {text?.txDetailStatus || (language === "zh" ? "状态" : "Status")}
            </Text>
            <Text style={[styles.detailValue, { color: confirmed ? theme.incoming : theme.warning }]}>
              {confirmed ? confirmedLabel : pendingLabel}
            </Text>
          </View>

          {timeText && (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>
                {text?.txDetailTime || (language === "zh" ? "时间" : "Time")}
              </Text>
              <Text style={[styles.detailValue, { color: theme.text }]}>
                {timeText}
              </Text>
            </View>
          )}
          
          <Pressable 
            onPress={handleOpenExplorer}
            style={[styles.explorerBtn, { backgroundColor: theme.accent }]}
          >
            <Text style={[styles.explorerBtnText, { color: theme.primaryButtonText }]}>
              🔗 {text?.txDetailExplorer || (language === "zh" ? "在区块链浏览器查看" : "View on Block Explorer")}
            </Text>
          </Pressable>
        </View>
      )}
    </Pressable>
  );
}

export const TransactionItem = React.memo(TransactionItemComponent);

const styles = StyleSheet.create({
  row: { flexDirection: "column", padding: 12, borderRadius: 8, borderWidth: 1 },
  compactRow: { borderWidth: 0, borderRadius: 0 },
  pressable: { cursor: "pointer" },
  mainRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  icon: { width: 38, height: 38, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  iconText: { fontSize: 10, fontWeight: "900" },
  info: { flex: 1, minWidth: 0 },
  hash: { fontWeight: "800", fontSize: 13 },
  status: { fontSize: 11, marginTop: 4, fontWeight: "700" },
  time: { fontSize: 10, marginTop: 3, fontWeight: "600" },
  amounts: { alignItems: "flex-end" },
  amount: { fontWeight: "900", fontSize: 13 },
  cny: { fontSize: 11, marginTop: 4 },
  expandIcon: { fontSize: 12, marginLeft: 4 },
  expandedContent: { 
    marginTop: 12, 
    paddingTop: 12, 
    borderTopWidth: 1,
    gap: 10
  },
  detailRow: { 
    flexDirection: "row", 
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12
  },
  detailLabel: { 
    fontSize: 12, 
    fontWeight: "700",
    minWidth: 70
  },
  detailValue: { 
    flex: 1,
    fontSize: 12, 
    fontFamily: "monospace",
    textAlign: "right"
  },
  explorerBtn: {
    marginTop: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: "center"
  },
  explorerBtnText: {
    fontSize: 13,
    fontWeight: "900"
  }
});
