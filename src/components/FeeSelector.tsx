import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

export type FeeTier = "slow" | "medium" | "fast";

export function FeeSelector({
  tiers,
  selected,
  onSelect,
  labels
}: {
  tiers: { slow: number; medium: number; fast: number };
  selected: FeeTier;
  onSelect: (tier: FeeTier) => void;
  labels: { slow: string; medium: string; fast: string; slowTime: string; mediumTime: string; fastTime: string };
}) {
  const { theme } = useTheme();
  const options: Array<{ key: FeeTier; label: string; time: string; rate: number }> = [
    { key: "slow", label: labels.slow, time: labels.slowTime, rate: tiers.slow },
    { key: "medium", label: labels.medium, time: labels.mediumTime, rate: tiers.medium },
    { key: "fast", label: labels.fast, time: labels.fastTime, rate: tiers.fast }
  ];

  return (
    <View style={styles.row}>
      {options.map((opt) => (
        <Pressable
          key={opt.key}
          onPress={() => onSelect(opt.key)}
          style={[
            styles.tier,
            { backgroundColor: selected === opt.key ? `${theme.accent}18` : theme.input, borderColor: selected === opt.key ? theme.accent : theme.inputBorder },
          ]}
        >
          <Text style={{ color: selected === opt.key ? theme.accent : theme.text, fontWeight: "900", fontSize: 13 }}>{opt.label}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{opt.time}</Text>
          <Text style={{ color: theme.textMuted, fontSize: 11, marginTop: 4 }}>{opt.rate} sat/vB</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 8 },
  tier: { flex: 1, minHeight: 88, padding: 10, borderRadius: 8, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});
