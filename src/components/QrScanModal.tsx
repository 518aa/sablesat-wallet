import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useTheme } from "../hooks/useTheme";
import type { ReturnTypeT } from "../i18n";

type Props = {
  visible: boolean;
  text: ReturnTypeT;
  onScan: (data: string) => void;
  onClose: () => void;
};

// 通用二维码扫描弹窗：基于 expo-camera 的 CameraView。
// 用于发送页“收款方地址”扫码等场景。
export function QrScanModal({ visible, text, onScan, onClose }: Props) {
  const { theme } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (visible) setScanned(false);
  }, [visible]);

  if (!visible) return null;

  if (!permission || !permission.granted) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={[styles.center, { backgroundColor: theme.bg }]}>
          <Text style={[styles.message, { color: theme.text }]}>{text.cameraPermissionRequired}</Text>
          <Pressable
            onPress={() => requestPermission()}
            style={[styles.button, { backgroundColor: theme.primaryButton }]}
          >
            <Text style={[styles.buttonText, { color: theme.primaryButtonText }]}>{text.cameraGrant}</Text>
          </Pressable>
          <Pressable
            onPress={onClose}
            style={[styles.button, { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 }]}
          >
            <Text style={[styles.buttonText, { color: theme.text }]}>{text.cancel}</Text>
          </Pressable>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.full}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={(result) => {
            if (scanned) return;
            setScanned(true);
            onScan(result.data);
          }}
        />
        <View style={[styles.topBar, { borderBottomColor: theme.border }]}>
          <Pressable onPress={onClose} style={[styles.closeBtn, { backgroundColor: theme.surface }]}>
            <Text style={[styles.closeText, { color: theme.text }]}>{text.cancel}</Text>
          </Pressable>
          <Text style={[styles.title, { color: "#fff" }]}>{text.scanQrTitle}</Text>
          <View style={styles.spacer} />
        </View>
        <View style={styles.frame} pointerEvents="none">
          <View style={[styles.frameBox, { borderColor: "rgba(255,255,255,0.85)" }]} />
        </View>
        <Text style={[styles.hint, { color: "#fff" }]}>{text.scanQrHint}</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  message: { fontSize: 16, fontWeight: "800", textAlign: "center" },
  button: { minHeight: 48, borderRadius: 8, paddingHorizontal: 20, alignItems: "center", justifyContent: "center" },
  buttonText: { fontWeight: "900", fontSize: 15 },
  full: { flex: 1, backgroundColor: "#000" },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 12,
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
  },
  closeBtn: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  closeText: { fontWeight: "900" },
  spacer: { width: 64 },
  title: { fontSize: 17, fontWeight: "900" },
  frame: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", zIndex: 1 },
  frameBox: { width: 240, height: 240, borderRadius: 16, borderWidth: 2 },
  hint: { position: "absolute", bottom: 64, left: 0, right: 0, textAlign: "center", fontSize: 13, fontWeight: "800", opacity: 0.9, zIndex: 2 },
});
