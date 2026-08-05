import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../hooks/useTheme";

// Full-screen modal overlay with a native-driven ActivityIndicator. Used to
// cover async work (signing, broadcasting, vault creation) so the user never
// mistakes a brief freeze for a hang. ActivityIndicator runs on the native UI
// thread, so it keeps spinning even if the JS thread is briefly busy.
export function LoadingOverlay({ visible, label }: { visible: boolean; label: string }) {
  const { theme } = useTheme();
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="none" onRequestClose={() => {}}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center" },
  card: { paddingHorizontal: 28, paddingVertical: 24, borderRadius: 12, alignItems: "center", gap: 14, minWidth: 180, borderWidth: 1 },
  label: { fontSize: 14, fontWeight: "800" },
});
