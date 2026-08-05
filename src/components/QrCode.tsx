import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import qrcode from "qrcode-generator";
import { useTheme } from "../hooks/useTheme";
import { logger } from "../services/logger";

type QrDot = { x: number; y: number };

type Props = {
  value: string;
  size?: number;
  eccLevel?: "L" | "M" | "Q" | "H";
  centerLabel?: string;
};

export function QrCode({ value, size = 190, eccLevel = "M", centerLabel }: Props) {
  const { theme } = useTheme();
  const qr = useMemo(() => {
    // qrcode-generator's addData/make can throw on edge inputs (empty string,
    // overflow, non-string). This runs during render, so a throw here crashes
    // the whole app via the top-level error boundary. Degrade to an empty
    // matrix instead.
    try {
      const model = qrcode(0, eccLevel);
      model.addData(value ?? "");
      model.make();
      const count = model.getModuleCount();
      const dots: QrDot[] = [];
      for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
          if (model.isDark(y, x)) dots.push({ x, y });
        }
      }
      return { count, dots };
    } catch (e) {
      logger.warn("QrCode generation failed", e);
      return { count: 0, dots: [] as QrDot[] };
    }
  }, [value, eccLevel]);

  const matrixSize = size - 36;
  const cellSize = qr.count > 0 ? matrixSize / qr.count : 0;

  return (
    <View style={[styles.shell, { width: size, height: size, backgroundColor: "#fff" }]}>
      <View style={{ width: matrixSize, height: matrixSize, position: "relative" }}>
        {qr.dots.map((dot) => (
          <View
            key={`${dot.x}-${dot.y}`}
            style={{
              position: "absolute",
              left: dot.x * cellSize,
              top: dot.y * cellSize,
              width: cellSize,
              height: cellSize,
              backgroundColor: "#111",
            }}
          />
        ))}
        {centerLabel && (
          <View
            style={[
              styles.center,
              {
                width: Math.max(36, matrixSize * 0.22),
                height: Math.max(36, matrixSize * 0.22),
                borderRadius: Math.max(18, matrixSize * 0.11),
                backgroundColor: theme.accent,
              },
            ]}
          >
            <Text style={[styles.centerText, { color: theme.primaryButtonText }]}>{centerLabel}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 8,
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    position: "absolute",
    alignSelf: "center",
    top: "50%",
    marginTop: -18,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 4,
    borderColor: "#fff",
  },
  centerText: {
    fontSize: 18,
    fontWeight: "900",
  },
});
