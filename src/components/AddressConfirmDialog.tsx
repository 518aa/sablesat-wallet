import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Theme } from "../theme";

type Props = {
  visible: boolean;
  theme: Theme;
  address: string;
  amountLabel: string;
  assetLabel: string;
  title: string;
  subtitle: string;
  confirmLabel: string;
  cancelLabel: string;
  warningText: string;
  onConfirm: () => void;
  onCancel: () => void;
};

const HIGHLIGHT_HEAD = 8;
const HIGHLIGHT_TAIL = 8;

export function AddressConfirmDialog({
  visible,
  theme,
  address,
  amountLabel,
  assetLabel,
  title,
  subtitle,
  confirmLabel,
  cancelLabel,
  warningText,
  onConfirm,
  onCancel,
}: Props) {
  const head = address.slice(0, HIGHLIGHT_HEAD);
  const tail = address.slice(-HIGHLIGHT_TAIL);
  const middle = address.slice(HIGHLIGHT_HEAD, -HIGHLIGHT_TAIL);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>

          <View style={[styles.amountBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}>
            <Text style={[styles.amountLabel, { color: theme.textMuted }]}>{assetLabel}</Text>
            <Text style={[styles.amountValue, { color: theme.text }]}>{amountLabel}</Text>
          </View>

          <View style={[styles.addressBox, { backgroundColor: theme.input, borderColor: theme.inputBorder }]}>
            <Text style={[styles.addressHeadTail, { color: theme.accent }]}>{head}</Text>
            <Text style={[styles.addressMiddle, { color: theme.textMuted }]} numberOfLines={1}>{middle}</Text>
            <Text style={[styles.addressHeadTail, { color: theme.accent }]}>{tail}</Text>
          </View>

          <Text style={[styles.warning, { color: theme.outgoing }]}>{warningText}</Text>

          <View style={styles.buttonRow}>
            <Pressable onPress={onCancel} style={[styles.cancelBtn, { backgroundColor: theme.surface, borderColor: theme.inputBorder }]}>
              <Text style={[styles.cancelText, { color: theme.text }]}>{cancelLabel}</Text>
            </Pressable>
            <Pressable onPress={onConfirm} style={[styles.confirmBtn, { backgroundColor: theme.primaryButton }]}>
              <Text style={[styles.confirmText, { color: theme.primaryButtonText }]}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", alignItems: "center", padding: 20 },
  card: { width: "100%", maxWidth: 380, borderRadius: 12, borderWidth: 1, padding: 20, gap: 12 },
  title: { fontSize: 18, fontWeight: "900", textAlign: "center" },
  subtitle: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  amountBox: { borderRadius: 8, borderWidth: 1, paddingVertical: 14, alignItems: "center" },
  amountLabel: { fontSize: 11, fontWeight: "800", marginBottom: 4 },
  amountValue: { fontSize: 20, fontWeight: "900" },
  addressBox: { flexDirection: "row", borderRadius: 8, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 10, alignItems: "center" },
  addressHeadTail: { fontSize: 13, fontWeight: "900", fontFamily: "monospace" },
  addressMiddle: { flex: 1, fontSize: 11, fontFamily: "monospace", paddingHorizontal: 4, overflow: "hidden" },
  warning: { fontSize: 11, lineHeight: 16, fontWeight: "700" },
  buttonRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  cancelBtn: { flex: 1, minHeight: 46, borderRadius: 8, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  cancelText: { fontSize: 14, fontWeight: "900" },
  confirmBtn: { flex: 1.4, minHeight: 46, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  confirmText: { fontSize: 14, fontWeight: "900" },
});
