import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../hooks/useTheme";

type PinDialogProps = {
  visible: boolean;
  title: string;
  subtitle?: string;
  errorText?: string;
  cancelLabel?: string;
  onPinEntered: (pin: string) => void;
  onCancel: () => void;
  busy?: boolean;
  busyLabel?: string;
};

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

export function PinDialog({
  visible,
  title,
  subtitle,
  errorText,
  cancelLabel = "Cancel",
  onPinEntered,
  onCancel,
  busy = false,
  busyLabel,
}: PinDialogProps) {
  const { theme } = useTheme();
  const [digits, setDigits] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (visible) {
      setDigits("");
      submittedRef.current = false;
      setSubmitting(false);
    }
  }, [visible, title]);

  useEffect(() => {
    if (visible && errorText) {
      setDigits("");
      submittedRef.current = false;
      setSubmitting(false);
    }
  }, [errorText, visible]);

  useEffect(() => {
    if (digits.length === 6 && !submittedRef.current) {
      submittedRef.current = true;
      // 立刻进入 submitting 状态——本地 setState 同步触发 re-render，
      // 不依赖父组件的 busy prop 在 await 后才生效（避免 dot 立即清空但
      // spinner 还没出现的 50-200ms 空窗）。
      setSubmitting(true);
      onPinEntered(digits);
      setDigits("");
    }
  }, [digits, onPinEntered]);

  function pressKey(key: string) {
    if (!key) return;
    if (key === "back") {
      setDigits((value) => value.slice(0, -1));
      return;
    }
    setDigits((value) => (value.length < 6 ? `${value}${key}` : value));
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={(busy || submitting) ? undefined : onCancel}>
      <View style={styles.backdrop} />
      <View style={styles.center}>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
          {subtitle && !(busy || submitting) && <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>}
          {(busy || submitting) ? (
            <View style={styles.busyWrap}>
              <ActivityIndicator color={theme.accent} size="large" />
              {busyLabel && <Text style={[styles.busyText, { color: theme.textSecondary }]}>{busyLabel}</Text>}
            </View>
          ) : (
            <>
              <View style={styles.dots}>
                {Array.from({ length: 6 }).map((_, i) => (
                  <View
                    key={i}
                    style={[styles.dot, { borderColor: theme.textMuted }, i < digits.length && { backgroundColor: theme.accent, borderColor: theme.accent }]}
                  />
                ))}
              </View>
              {errorText && <Text style={[styles.error, { color: theme.outgoing }]}>{errorText}</Text>}
              <View style={styles.keypad}>
                {keys.map((key, index) => (
                  <Pressable
                    key={`${key}-${index}`}
                    disabled={!key || submitting}
                    onPress={() => pressKey(key)}
                    style={[styles.key, { backgroundColor: theme.surface }, !key && styles.keyBlank]}
                  >
                    <Text style={[styles.keyText, { color: theme.text }]}>{key === "back" ? "⌫" : key}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}

          {!(busy || submitting) && cancelLabel ? (
            <Pressable onPress={onCancel} style={styles.cancelBtn}>
              <Text style={[styles.cancelText, { color: theme.textSecondary }]}>{cancelLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.62)" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  card: {
    borderRadius: 12,
    padding: 22,
    width: "100%",
    maxWidth: 340,
    alignItems: "center",
    gap: 16,
    borderWidth: 1,
  },
  title: { fontSize: 18, fontWeight: "900", textAlign: "center" },
  subtitle: { fontSize: 13, lineHeight: 18, textAlign: "center" },
  busyWrap: { paddingVertical: 18, alignItems: "center", gap: 14, minHeight: 90, justifyContent: "center" },
  busyText: { fontSize: 13, fontWeight: "800" },
  dots: { flexDirection: "row", gap: 11, paddingVertical: 3 },
  dot: { width: 15, height: 15, borderRadius: 8, borderWidth: 2 },
  error: { fontSize: 12, fontWeight: "800", textAlign: "center" },
  keypad: { width: "100%", flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  key: {
    width: 72,
    height: 50,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  keyBlank: { backgroundColor: "transparent" },
  keyText: { fontSize: 21, fontWeight: "900" },
  cancelBtn: { marginTop: 2, minHeight: 34, justifyContent: "center", paddingHorizontal: 12 },
  cancelText: { fontSize: 14, fontWeight: "800" },
});
