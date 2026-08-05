import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import { Alert, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import qrcode from "qrcode-generator";
import { useTheme } from "../hooks/useTheme";
import { useAssets } from "../hooks/useAssets";
import { BTC_ASSET, EVM_CHAINS, type ChainId } from "../chains/tokens";
import type { ReturnTypeT } from "../i18n";
import { logger } from "../services/logger";

type Props = {
  btcAddress: string;
  evmAddress: string;
  copiedLabel: string;
  copyLabel: string;
  titleLabel: string;
  hintLabel: string;
  backLabel: string;
  onBack: () => void;
  text?: ReturnTypeT;
};

type QrDot = { x: number; y: number };

export function ReceiveScreen({ btcAddress, evmAddress, copiedLabel, copyLabel, titleLabel, hintLabel, backLabel, onBack, text }: Props) {
  const { theme } = useTheme();
  const { assets, groups } = useAssets(evmAddress);
  const [assetId, setAssetId] = useState("btc");
  const [expanded, setExpanded] = useState(false);

  const selectable = [BTC_ASSET, ...assets.map((a) => a.asset)];
  const selected = selectable.find((a) => a.id === assetId) ?? BTC_ASSET;
  const address = selected.kind === "btc" ? btcAddress : evmAddress;
  const assetName = selected.symbol;
  const networkName = selected.kind === "btc" ? "BTC" : EVM_CHAINS[selected.chainId as ChainId].shortName;
  const receiveHint = selected.kind === "btc"
    ? hintLabel
    : text?.receiveEvmHint
        ?.replace("{network}", EVM_CHAINS[selected.chainId as ChainId].name)
        ?.replace("{symbol}", selected.symbol)
        ?.replace("{fee}", EVM_CHAINS[selected.chainId as ChainId].feeSymbol) || `只接收 ${EVM_CHAINS[selected.chainId as ChainId].name} 网络的 ${selected.symbol}，转错网络可能无法找回。手续费需要少量 ${EVM_CHAINS[selected.chainId as ChainId].feeSymbol}。`;

  const qr = useMemo(() => {
    try {
      const model = qrcode(0, "M");
      model.addData(address ?? "");
      model.make();
      const count = model.getModuleCount();
      const dots: QrDot[] = [];
      for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
          if (model.isDark(y, x)) dots.push({ x, y });
        }
      }
      return { count, dots };
    } catch (e) {
      logger.warn("ReceiveScreen QR generation failed", e);
      return { count: 0, dots: [] as QrDot[] };
    }
  }, [address]);

  async function handleCopy() {
    await Clipboard.setStringAsync(address);
    Alert.alert("SableSat", copiedLabel);
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={backLabel} hitSlop={8} style={[styles.backButton, { backgroundColor: theme.surface }]}>
          <Text style={[styles.backText, { color: theme.text }]}>{backLabel}</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{titleLabel}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.text }]}>{copyLabel}</Text>
        <View style={styles.assetPicker}>
          <Pressable onPress={() => setAssetId("btc")} style={[styles.assetChip, { backgroundColor: assetId === "btc" ? `${theme.accent}22` : theme.surface, borderColor: assetId === "btc" ? theme.accent : theme.border }]}>
            <Text style={[styles.assetChipText, { color: assetId === "btc" ? theme.accent : theme.text }]}>BTC</Text>
            <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>Bitcoin</Text>
          </Pressable>
          <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" accessibilityLabel={text?.moreAssets || "More assets"} hitSlop={8} style={[styles.assetChip, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.assetChipText, { color: theme.text }]}>{expanded ? "▲" : "▼"}</Text>
            <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>{selected.kind === "btc" ? "Bitcoin" : networkName}</Text>
          </Pressable>
        </View>

        {expanded && groups.map((g) => (
          <View key={g.chain} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.textSecondary }]}>{EVM_CHAINS[g.chain as ChainId].name}</Text>
            <View style={styles.assetPicker}>
              {g.assets.map((view) => (
                <Pressable key={view.asset.id} onPress={() => { setAssetId(view.asset.id); setExpanded(false); }} style={[styles.assetChip, { backgroundColor: assetId === view.asset.id ? `${theme.accent}22` : theme.surface, borderColor: assetId === view.asset.id ? theme.accent : theme.border }]}>
                  <Text style={[styles.assetChipText, { color: assetId === view.asset.id ? theme.accent : theme.text }]}>{view.asset.symbol}</Text>
                  <Text style={[styles.assetChipSub, { color: theme.textMuted }]}>{EVM_CHAINS[g.chain as ChainId].shortName}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}

        <View style={styles.cardHeader}>
          <Text style={[styles.walletLabel, { color: theme.text }]}>{assetName}</Text>
          <View style={[styles.primaryBadge, { backgroundColor: `${theme.accent}20` }]}>
            <Text style={[styles.primaryBadgeText, { color: theme.accent }]}>{networkName}</Text>
          </View>
        </View>

        <View style={styles.qrShell}>
          <QrMatrix count={qr.count} dots={qr.dots} />
          <View style={[styles.qrCenter, { backgroundColor: theme.accent }]}>
            <Text style={[styles.qrCenterText, { color: theme.primaryButtonText }]}>{selected.kind === "btc" ? "₿" : "$"}</Text>
          </View>
        </View>

        <Text style={[styles.hint, { color: theme.textSecondary }]}>{receiveHint}</Text>
        <Pressable onPress={handleCopy} accessibilityRole="button" accessibilityLabel={text?.copyAddress || copyLabel} hitSlop={8} style={[styles.addressBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}>
          <Text style={[styles.address, { color: theme.text }]} selectable>{address}</Text>
          <Text style={[styles.copyMini, { color: theme.textMuted }]}>COPY</Text>
        </Pressable>
      </View>

      <Pressable onPress={handleCopy} accessibilityRole="button" accessibilityLabel={copyLabel} style={[styles.copyBtn, { backgroundColor: theme.primaryButton }]}>
        <Text style={[styles.copyText, { color: theme.primaryButtonText }]}>{copyLabel}</Text>
      </Pressable>
    </View>
  );
}

function QrMatrix({ count, dots }: { count: number; dots: QrDot[] }) {
  const cellSize = 154 / count;
  return (
    <View style={styles.qrMatrix}>
      {dots.map((dot) => (
        <View
          key={`${dot.x}-${dot.y}`}
          style={[
            styles.qrDot,
            {
              left: dot.x * cellSize,
              top: dot.y * cellSize,
              width: cellSize,
              height: cellSize,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: (StatusBar.currentHeight ?? 24) + 12, gap: 14 },
  topBar: { height: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  backButton: { minWidth: 64, height: 34, borderRadius: 8, paddingHorizontal: 10, justifyContent: "center", alignItems: "center" },
  backText: { fontSize: 12, fontWeight: "900" },
  headerSpacer: { width: 64 },
  title: { fontSize: 17, fontWeight: "900" },
  card: { padding: 16, borderRadius: 8, borderWidth: 1, gap: 14 },
  label: { fontWeight: "900", fontSize: 13 },
  assetPicker: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  group: { gap: 8, marginTop: 4 },
  groupTitle: { fontSize: 12, fontWeight: "900", marginLeft: 2 },
  assetChip: { minWidth: 82, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8 },
  assetChipText: { fontSize: 13, fontWeight: "900" },
  assetChipSub: { fontSize: 10, fontWeight: "800", marginTop: 2 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  walletLabel: { fontSize: 14, fontWeight: "900" },
  primaryBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  primaryBadgeText: { fontSize: 10, fontWeight: "900" },
  qrShell: { width: 190, height: 190, alignSelf: "center", backgroundColor: "#fff", borderRadius: 8, padding: 18, alignItems: "center", justifyContent: "center" },
  qrMatrix: { width: 154, height: 154, position: "relative" },
  qrDot: { position: "absolute", backgroundColor: "#111" },
  qrCenter: { position: "absolute", width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: "#fff" },
  qrCenterText: { fontSize: 22, fontWeight: "900" },
  hint: { fontSize: 12, lineHeight: 18 },
  addressBox: { borderWidth: 1, borderRadius: 8, padding: 13, flexDirection: "row", alignItems: "center", gap: 8 },
  address: { flex: 1, fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
  copyMini: { fontSize: 10, fontWeight: "900" },
  copyBtn: { minHeight: 54, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: "auto" },
  copyText: { fontWeight: "900", fontSize: 15 }
});
