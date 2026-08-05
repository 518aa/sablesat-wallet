import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { QrCode } from "./QrCode";
import { useTheme } from "../hooks/useTheme";
import { planPsbtQr, UrUnavailableError, type PsbtQrPlan } from "../services/vault/ur";
import { logger } from "../services/logger";

// ───────────────────────────────────────────────────────────────────────────
// PSBT 二维码输出：小 PSBT 用单张静态码，超容量自动切换 BC-UR 动态轮播。
//
// 【接线之前的状态】vault/ur.ts 早就写好了（planPsbtQr / PsbtUrScanner），
// @ngraveio/bc-ur 也在 package.json 里，但**全项目零调用**。各个屏幕的写法都是
//   psbtFitsQr(psbt) ? <QrCode/> : <Text>太长了</Text>
// 超过 1200 字符就只剩一句错误文案。而离线签名终端是气隙设备，剪贴板跨不过去，
// QR 是唯一通道 —— 也就是说 2-of-3 金库一旦需要 3 个输入（types.ts 自己算过
// "3 个以上输入必然超限"），已签 PSBT 就永远出不了那台设备。
//
// 这和 fetchBitcoinApiCrossChecked 是同一类问题：防线写在注释里，代码里不存在。
// ───────────────────────────────────────────────────────────────────────────

/** 每帧停留时长。太快摄像头跟不上，太慢大 PSBT 传一轮要等很久。 */
const FRAME_INTERVAL_MS = 250;

type Props = {
  psbtB64: string;
  size?: number;
  /** 单张码时显示的提示。 */
  hint?: string;
  /** 动态码时显示的提示，{frames} 会被替换成总帧数。 */
  animatedHint?: string;
  /** BC-UR 模块不可用且 PSBT 超容量时的提示。 */
  unavailableHint?: string;
};

export function PsbtQr({ psbtB64, size = 240, hint, animatedHint, unavailableHint }: Props) {
  const { theme } = useTheme();
  const [frameIdx, setFrameIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const plan = useMemo<PsbtQrPlan | { mode: "unavailable" }>(() => {
    try {
      return planPsbtQr(psbtB64);
    } catch (err) {
      if (err instanceof UrUnavailableError) return { mode: "unavailable" };
      logger.warn("planPsbtQr failed", err);
      return { mode: "unavailable" };
    }
  }, [psbtB64]);

  const frameCount = plan.mode === "animated" ? plan.frames.length : 0;

  useEffect(() => {
    setFrameIdx(0);
    if (plan.mode !== "animated") return;
    timerRef.current = setInterval(() => {
      setFrameIdx((i) => (i + 1) % frameCount);
    }, FRAME_INTERVAL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [plan.mode, frameCount]);

  if (plan.mode === "unavailable") {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.warn, { color: theme.outgoing }]}>
          {unavailableHint ?? "PSBT exceeds QR capacity and BC-UR is unavailable"}
        </Text>
      </View>
    );
  }

  if (plan.mode === "single") {
    return (
      <View style={styles.wrap}>
        <QrCode value={plan.payload} size={size} />
        {hint ? <Text style={[styles.hint, { color: theme.textSecondary }]}>{hint}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <QrCode value={plan.frames[frameIdx]} size={size} />
      <View style={styles.progressRow}>
        <View style={[styles.progressTrack, { backgroundColor: theme.surface }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: theme.accent, width: `${((frameIdx + 1) / frameCount) * 100}%` },
            ]}
          />
        </View>
        <Text style={[styles.counter, { color: theme.textMuted }]}>
          {`${frameIdx + 1}/${frameCount}`}
        </Text>
      </View>
      <Text style={[styles.hint, { color: theme.textSecondary }]}>
        {(animatedHint ?? "Keep the camera pointed here until the other device completes ({frames} frames)")
          .replace("{frames}", String(frameCount))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 10, paddingVertical: 4 },
  hint: { fontSize: 12, lineHeight: 17, textAlign: "center" },
  warn: { fontSize: 12, lineHeight: 18, textAlign: "center", fontWeight: "700" },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "stretch", paddingHorizontal: 12 },
  progressTrack: { flex: 1, height: 4, borderRadius: 2, overflow: "hidden" },
  progressFill: { height: 4, borderRadius: 2 },
  counter: { fontSize: 11, fontWeight: "900", fontVariant: ["tabular-nums"] },
});
