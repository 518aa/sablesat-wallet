import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../hooks/useTheme";
import { PsbtUrScanner } from "../services/vault/ur";
import { logger } from "../services/logger";

type Props = {
  onScanned: (data: string) => void;
  onClose: () => void;
  closeLabel: string;
  deniedTitle: string;
  deniedBody: string;
  authorizeLabel: string;
  scanHint?: string;
  /**
   * "psbt" 模式：累积 BC-UR 分片直到解码完成，再把完整 PSBT base64 交给 onScanned。
   * 单张静态码（cHNidP… base64）依然一帧即返回，向后兼容。
   *
   * 默认 "single"：扫到一帧就返回，用于收款地址、zpub 等短内容。
   */
  mode?: "single" | "psbt";
  /** psbt 模式下的进度文案，{percent} 会被替换。 */
  progressLabel?: string;
};

const FRAME_SIZE = 268;

// 全屏 Modal 扫码：用 RN Modal 覆盖整个屏幕（含 header/状态栏），解决之前
// 在屏内 in-flow 渲染导致扫码框位置不好看/被上沿遮挡的问题。相机铺满 →
// 四向半透明压暗遮罩 + 居中方形挖孔 + 四角装饰；关闭按钮走 safe area top inset；
// 框下提示文案。permission 未决/被拒也走全屏一致体验。
export function QrScanner({ onScanned, onClose, closeLabel, deniedTitle, deniedBody, authorizeLabel, scanHint, mode = "single", progressLabel }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const consumedRef = useRef(false);
  // BC-UR 增量解码器。只在 psbt 模式下创建，避免给普通扫码引入依赖。
  const urRef = useRef<PsbtUrScanner | null>(null);
  const [progress, setProgress] = useState(0);
  const [urError, setUrError] = useState<string | null>(null);

  useEffect(() => {
    if (permission && !permission.granted) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  function handleBarcode(event: { data?: string }) {
    if (consumedRef.current) return;
    const data = event.data?.trim();
    if (!data) return;

    if (mode !== "psbt") {
      consumedRef.current = true;
      onScanned(data);
      return;
    }

    // 动态码：一帧一帧喂进解码器，集齐才回调。
    if (!urRef.current) urRef.current = new PsbtUrScanner();
    try {
      const res = urRef.current.receive(data);
      if (res.done) {
        consumedRef.current = true;
        urRef.current = null;
        onScanned(res.psbtB64);
      } else {
        setProgress(res.progress);
        setUrError(null);
      }
    } catch (err) {
      // 解码失败（分片来自不同 PSBT / 数据损坏）：重置解码器让用户重扫，
      // 不要静默吞掉——否则用户会对着屏幕一直扫而毫无反馈。
      urRef.current = new PsbtUrScanner();
      setProgress(0);
      setUrError(err instanceof Error ? err.message : String(err));
      logger.warn("PSBT UR decode failed", err);
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.container}>
        {permission && permission.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={handleBarcode}
          />
        ) : null}

        {permission && !permission.granted ? (
          <View style={[styles.permissionBox, { paddingTop: insets.top + 24 }]}>
            {!permission ? (
              <ActivityIndicator color={theme.accent} />
            ) : (
              <>
                <Text style={[styles.deniedTitle, { color: theme.text }]}>{deniedTitle}</Text>
                <Text style={[styles.deniedBody, { color: theme.textSecondary }]}>{deniedBody}</Text>
                <Pressable onPress={requestPermission} style={[styles.actionBtn, { backgroundColor: theme.primaryButton }]}>
                  <Text style={[styles.actionBtnText, { color: theme.primaryButtonText }]}>{authorizeLabel}</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : (
          <>
            <View style={styles.overlayColumn} pointerEvents="none">
              <View style={styles.band} />
              <View style={styles.middleRow}>
                <View style={styles.side} />
                <View style={[styles.frame, { borderColor: theme.accent }]}>
                  <View style={[styles.corner, styles.cornerTL, { borderColor: theme.accent }]} />
                  <View style={[styles.corner, styles.cornerTR, { borderColor: theme.accent }]} />
                  <View style={[styles.corner, styles.cornerBL, { borderColor: theme.accent }]} />
                  <View style={[styles.corner, styles.cornerBR, { borderColor: theme.accent }]} />
                </View>
                <View style={styles.side} />
              </View>
              <View style={styles.band} />
            </View>
            <Text style={[styles.hint, { bottom: insets.bottom + 96 }]} pointerEvents="none">
              {urError
                ? urError
                : mode === "psbt" && progress > 0
                  ? (progressLabel ?? "Receiving… {percent}%").replace(
                      "{percent}",
                      String(Math.round(progress * 100)),
                    )
                  : scanHint || "将二维码对准框内"}
            </Text>
            {mode === "psbt" && progress > 0 && (
              <View style={[styles.progressTrack, { bottom: insets.bottom + 78 }]} pointerEvents="none">
                <View style={[styles.progressFill, { backgroundColor: theme.accent, width: `${progress * 100}%` }]} />
              </View>
            )}
          </>
        )}

        <View style={[styles.closeWrap, { top: insets.top + 10 }]}>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>{closeLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000" },
  permissionBox: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24, backgroundColor: "#000" },
  deniedTitle: { fontSize: 18, fontWeight: "900", color: "#fff" },
  deniedBody: { fontSize: 13, lineHeight: 18, textAlign: "center", color: "#cfd3da" },
  actionBtn: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  actionBtnText: { fontSize: 13, fontWeight: "900" },
  overlayColumn: { ...StyleSheet.absoluteFill, flexDirection: "column" },
  band: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  middleRow: { flexDirection: "row", height: FRAME_SIZE },
  side: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  frame: { width: FRAME_SIZE, height: FRAME_SIZE, borderWidth: 1, borderRadius: 14, backgroundColor: "transparent" },
  corner: { position: "absolute", width: 28, height: 28, borderWidth: 4, borderColor: "#fff" },
  cornerTL: { top: -2, left: -2, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 14 },
  cornerTR: { top: -2, right: -2, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 14 },
  cornerBL: { bottom: -2, left: -2, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 14 },
  cornerBR: { bottom: -2, right: -2, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 14 },
  hint: { position: "absolute", left: 0, right: 0, textAlign: "center", fontSize: 13, fontWeight: "700", color: "rgba(255,255,255,0.85)" },
  progressTrack: { position: "absolute", left: 40, right: 40, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)", overflow: "hidden" },
  progressFill: { height: 4, borderRadius: 2 },
  closeWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  closeBtn: { paddingVertical: 9, paddingHorizontal: 20, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.65)" },
  closeText: { color: "#fff", fontSize: 14, fontWeight: "900" },
});
