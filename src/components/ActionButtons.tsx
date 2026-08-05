import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";
import { hapticImpact } from "../utils/haptics";
import { press } from "../theme-tokens";

export function ActionButtons({
  onSend,
  onReceive,
  sendLabel,
  receiveLabel
}: {
  onSend: () => void;
  onReceive: () => void;
  sendLabel: string;
  receiveLabel: string;
}) {
  const { theme } = useTheme();

  return (
    <View style={styles.row}>
      <ActionButton label={receiveLabel} color={theme.receiveGradient[0]} onPress={onReceive} icon="↓" />
      <ActionButton label={sendLabel} color={theme.sendGradient[0]} onPress={onSend} icon="↑" />
    </View>
  );
}

function ActionButton({ label, color, onPress, icon }: { label: string; color: string; onPress: () => void; icon: string }) {
  const { theme } = useTheme();

  return (
    <Pressable
      onPress={() => { hapticImpact("medium"); onPress(); }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: theme.card, borderColor: theme.border },
        pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
      ]}
    >
      <View style={[styles.circle, { borderColor: color, backgroundColor: `${color}16` }]}>
        <Text style={[styles.icon, { color }]}>{icon}</Text>
      </View>
      <Text style={[styles.label, { color }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, paddingVertical: 2 },
  action: {
    flex: 1,
    minHeight: 78,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 14
  },
  circle: { width: 42, height: 42, borderRadius: 21, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 25, fontWeight: "700", lineHeight: 27 },
  label: { fontSize: 19, fontWeight: "700" }
});
