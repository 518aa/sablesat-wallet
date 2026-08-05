import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme, type ThemeMode } from "../hooks/useTheme";
import { hapticImpact } from "../utils/haptics";
import { press } from "../theme-tokens";

const options: Array<{ key: ThemeMode; label: string }> = [
  { key: "sable", label: "Sable" },
  { key: "porcelain", label: "Porcelain" },
  { key: "aurora", label: "Aurora" },
];

export function ThemeToggle() {
  const { mode, setMode, theme } = useTheme();

  return (
    <View style={[styles.switch, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {options.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => { hapticImpact("light"); setMode(item.key); }}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: mode === item.key }}
          style={({ pressed }) => [
            styles.btn,
            mode === item.key && { backgroundColor: theme.card, borderColor: theme.accent },
            pressed && { opacity: 0.7, transform: [{ scale: press.scale }] },
          ]}
        >
          <Text style={[styles.text, { color: mode === item.key ? theme.text : theme.textMuted }]}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  switch: { flexDirection: "row", padding: 4, borderRadius: 10, borderWidth: 1, alignSelf: "flex-start", flexWrap: "wrap", gap: 4 },
  btn: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 7, borderWidth: 1, borderColor: "transparent" },
  text: { fontWeight: "800", fontSize: 12 }
});
