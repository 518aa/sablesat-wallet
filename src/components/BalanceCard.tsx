import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { Skeleton } from "./ui/Skeleton";
import { radius, press, tnum } from "../theme-tokens";
import type { Language, ReturnTypeT } from "../i18n";
import { satsToBtc, SATS_PER_BTC } from "../utils/bitcoin";
import { formatCny } from "../utils/format";

export function BalanceCard({
  balanceSats,
  priceCny,
  btcUsd = 0,
  totalUsd = 0,
  totalCny = 0,
  assetLabel,
  assetHint,
  busy,
  loading = false,
  onRefresh,
  refreshingLabel,
  refreshLabel,
  priceLabel,
  priceUnavailableLabel,
  language,
  text
}: {
  balanceSats: number;
  priceCny: number | null;
  btcUsd?: number;
  totalUsd?: number;
  totalCny?: number;
  assetLabel: string;
  assetHint: string;
  busy: boolean;
  loading?: boolean;
  onRefresh: () => void;
  refreshingLabel: string;
  refreshLabel: string;
  priceLabel: string;
  priceUnavailableLabel: string;
  language: Language;
  text?: ReturnTypeT;
}) {
  const { theme } = useTheme();
  const btc = satsToBtc(balanceSats);
  const fiatValue = priceCny
    ? formatCny((balanceSats / SATS_PER_BTC) * priceCny, language)
    : null;

  const btcPct = totalUsd > 0 ? Math.max(0, Math.min(1, btcUsd / totalUsd)) : 0;
  const tokenPct = 1 - btcPct;
  const showAllocation = totalUsd > 0;

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <View style={[styles.glow, { backgroundColor: `${theme.accent}18` }]} />
      <View style={styles.header}>
        <View style={[styles.headerLabel, { flex: 1, minWidth: 0 }]}>
          <Text style={[styles.assetLabel, { color: theme.accent }]}>{assetLabel}</Text>
          <Text style={[styles.priceHint, { color: theme.textMuted }]}>{assetHint}</Text>
        </View>
        <Pressable
          disabled={busy || loading}
          onPress={onRefresh}
          accessibilityRole="button"
          accessibilityLabel={busy ? refreshingLabel : refreshLabel}
          style={({ pressed }) => [
            styles.refreshButton,
            { backgroundColor: theme.surface, borderColor: theme.border, flexShrink: 0 },
            pressed && !loading && { opacity: press.opacity, transform: [{ scale: press.scale }] },
          ]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <Text style={[styles.refreshIcon, { color: theme.text }]}>↻</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.mainRow}>
        <View style={styles.balanceBlock}>
          {loading ? (
            <>
              <Skeleton width={176} height={40} radius={8} />
              <Skeleton width={140} height={13} radius={6} style={styles.cnySkeleton} />
            </>
          ) : (
            <>
              <Text style={[styles.balance, tnum, { color: theme.text }]} adjustsFontSizeToFit numberOfLines={1}>
                {`¥${formatCny(totalCny, language)}`}
              </Text>
              <Text style={[styles.cny, tnum, { color: theme.textSecondary }]} numberOfLines={1} adjustsFontSizeToFit>
                {`BTC ${btc}`}
              </Text>
            </>
          )}
        </View>
        <View style={[styles.coinShell, { backgroundColor: `${theme.accent}16`, borderColor: `${theme.accent}45` }]}>
          <Image source={require("../../assets/sablesat-icon.png")} style={styles.coinImage} resizeMode="cover" />
        </View>
      </View>

      {showAllocation && !loading && (
        <View style={styles.allocWrap}>
          <View style={styles.allocBar}>
            <View style={[styles.allocSeg, { flex: btcPct || 0.001, backgroundColor: theme.accent }]} />
            <View style={[styles.allocSeg, { flex: tokenPct || 0.001, backgroundColor: theme.incoming }]} />
          </View>
          <View style={styles.allocLegend}>
            <Text style={[styles.allocText, { color: theme.textSecondary }]}>
              {`BTC ${Math.round(btcPct * 100)}%`}
            </Text>
            <Text style={[styles.allocText, { color: theme.textSecondary }]}>
              {`${text?.tokenPctLabel || (language === "zh" ? "代币" : "Tokens")} ${Math.round(tokenPct * 100)}%`}
            </Text>
          </View>
        </View>
      )}

      <View style={[styles.metaRow, { borderTopColor: theme.border }]}>
        <Text style={[styles.refreshText, { color: theme.textMuted }]}>{busy ? refreshingLabel : refreshLabel}</Text>
        <View style={[styles.pricePill, { backgroundColor: `${theme.incoming}16`, borderColor: `${theme.incoming}42` }]}>
          <Text style={[styles.pricePrefix, { color: theme.textMuted }]}>{priceLabel}</Text>
          <Text style={[styles.priceText, tnum, { color: priceCny ? theme.incoming : theme.textMuted }]}>
            {priceCny ? formatCny(priceCny, language) : "--"}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: 210,
    padding: 18,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 16,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 14 }
  },
  glow: { position: "absolute", right: -32, top: 18, width: 150, height: 150, borderRadius: 75 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerLabel: { marginRight: 8 },
  assetLabel: { fontSize: 20, fontWeight: "800", letterSpacing: 0 },
  priceHint: { fontSize: 11, marginTop: 4, fontWeight: "500" },
  refreshButton: { width: 34, height: 34, borderRadius: radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  refreshIcon: { fontSize: 16, fontWeight: "900" },
  mainRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  balanceBlock: { flex: 1, minWidth: 0 },
  balance: { fontSize: 44, fontWeight: "800", letterSpacing: 0 },
  cny: { fontSize: 13, fontWeight: "500", marginTop: 8 },
  cnySkeleton: { marginTop: 10 },
  coinShell: { width: 82, height: 82, borderRadius: 41, borderWidth: 1, overflow: "hidden" },
  coinImage: { width: "100%", height: "100%" },
  allocWrap: { gap: 8, marginTop: 2 },
  allocBar: { flexDirection: "row", height: 8, borderRadius: radius.pill, overflow: "hidden", backgroundColor: "rgba(128,128,128,0.18)" },
  allocSeg: { height: 8 },
  allocLegend: { flexDirection: "row", justifyContent: "space-between" },
  allocText: { fontSize: 11, fontWeight: "600" },
  metaRow: { borderTopWidth: 1, paddingTop: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  refreshText: { fontSize: 11, fontWeight: "500" },
  pricePill: { borderRadius: radius.sm, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 7 },
  priceText: { fontSize: 12, fontWeight: "900" },
  pricePrefix: { fontSize: 11, fontWeight: "600", marginRight: 4 }
});
