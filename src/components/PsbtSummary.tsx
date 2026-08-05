import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { summarizePsbt } from "../services/vault/psbt";
import { satsToBtc } from "../utils/bitcoin";
import type { VaultConfig, VaultUtxo } from "../services/vault/types";
import type { ReturnTypeT } from "../i18n";

type Props = {
  psbtB64: string;
  vault: VaultConfig;
  knownInputs?: VaultUtxo[];
  signaturesNeeded: number;
  text: ReturnTypeT;
};

export function PsbtSummary({ psbtB64, vault, knownInputs = [], signaturesNeeded, text }: Props) {
  const { theme } = useTheme();
  let summary;
  try {
    summary = summarizePsbt(psbtB64, vault, knownInputs);
  } catch (err) {
    return (
      <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.outgoing }]}>
        <Text style={[styles.errorText, { color: theme.outgoing }]}>
          {err instanceof Error ? err.message : "Invalid PSBT"}
        </Text>
      </View>
    );
  }

  const sendOutputs = summary.outputs.filter((o) => !o.isChange);
  const totalSend = sendOutputs.reduce((s, o) => s + o.sats, 0);

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
      <Text style={[styles.sectionTitle, { color: theme.text }]}>{vault.name}</Text>

      {/* 收款方 / 找零 逐笔确认 */}
      <View style={styles.outputs}>
        {summary.outputs.map((o, i) => (
          <View key={i} style={[styles.outputRow, o.isChange && { opacity: 0.7 }]}>
            <View style={styles.outputTagWrap}>
              <Text
                style={[
                  styles.outputTag,
                  o.isChange
                    ? { color: theme.textMuted, backgroundColor: theme.surface }
                    : { color: "#FFFFFF", backgroundColor: theme.outgoing },
                ]}
              >
                {o.isChange ? text.psbtChange : text.psbtRecipient}
              </Text>
            </View>
            <View style={styles.outputBody}>
              <Text style={[styles.outputAddr, { color: theme.text }]} selectable>
                {o.address || text.psbtUnknownAddress}
              </Text>
              <Text style={[styles.outputAmt, { color: o.isChange ? theme.textMuted : theme.text }]}>
                {satsToBtc(o.sats)} BTC
              </Text>
            </View>
          </View>
        ))}
      </View>

      {sendOutputs.length > 0 && (
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.textSecondary }]}>{text.psbtTotalSend}</Text>
          <Text style={[styles.value, { color: theme.text }]}>{`${satsToBtc(totalSend)} BTC`}</Text>
        </View>
      )}

      <View style={styles.divider} />

      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.textSecondary }]}>Inputs</Text>
        <Text style={[styles.value, { color: theme.text }]}>{summary.inputs.length}</Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.textSecondary }]}>Fee</Text>
        <Text style={[styles.value, { color: theme.text }]}>{`${summary.feeSats} sats`}</Text>
      </View>

      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.textSecondary }]}>Signatures</Text>
        <Text
          style={[
            styles.value,
            {
              color: summary.readyToFinalize ? theme.incoming : theme.warning,
            },
          ]}
        >
          {`${summary.signaturesPerInput[0] ?? 0}/${signaturesNeeded}`}
        </Text>
      </View>

      {summary.readyToFinalize && (
        <Text style={[styles.readyText, { color: theme.incoming }]}>Ready to finalize</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 10, borderWidth: 1, gap: 8 },
  sectionTitle: { fontSize: 13, fontWeight: "900", letterSpacing: 0.4 },
  outputs: { gap: 8 },
  outputRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  outputTagWrap: { paddingTop: 2 },
  outputTag: { fontSize: 10, fontWeight: "900", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, overflow: "hidden" },
  outputBody: { flex: 1, gap: 2 },
  outputAddr: { fontSize: 11, fontFamily: "monospace", lineHeight: 15 },
  outputAmt: { fontSize: 13, fontWeight: "900" },
  divider: { height: 1, backgroundColor: "rgba(127,127,127,0.25)", marginVertical: 2 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 12 },
  value: { fontSize: 13, fontWeight: "900" },
  readyText: { fontSize: 12, fontWeight: "900", letterSpacing: 0.5 },
  errorText: { fontSize: 12 },
});
