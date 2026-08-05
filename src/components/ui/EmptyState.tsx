import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../hooks/useTheme";

// Centered empty/placeholder block with an optional glyph, title and hint.
// Used where a list would normally be, so an empty state still teaches the
// user what belongs there.
export function EmptyState({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  const { theme } = useTheme();
  return (
    <View style={styles.box}>
      {icon ? <Text style={[styles.icon, { color: theme.textMuted }]}>{icon}</Text> : null}
      <Text style={[styles.title, { color: theme.textSecondary }]}>{title}</Text>
      {hint ? <Text style={[styles.hint, { color: theme.textMuted }]}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: "center", justifyContent: "center", paddingVertical: 28, paddingHorizontal: 24, gap: 8 },
  icon: { fontSize: 30, fontWeight: "300", lineHeight: 34 },
  title: { fontSize: 15, fontWeight: "800", textAlign: "center" },
  hint: { fontSize: 12, fontWeight: "600", textAlign: "center", lineHeight: 18 },
});
