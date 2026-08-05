import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";

// Inline, labeled spinner. Use it for any async wait so the user always knows
// what is happening (signing, broadcasting, fetching balance, loading more).
export function Spinner({
  label,
  size = "small",
  color,
}: {
  label?: string;
  size?: "small" | "large";
  color?: string;
}) {
  const { theme } = useTheme();
  return (
    <View style={[styles.row, label ? styles.rowWithLabel : null]}>
      <ActivityIndicator size={size === "large" ? "large" : "small"} color={color ?? theme.accent} />
      {label ? <Text style={[styles.label, { color: theme.textSecondary }]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  rowWithLabel: { gap: 10, paddingVertical: 8, paddingHorizontal: 12 },
  label: { fontSize: 13, fontWeight: "800" },
});
