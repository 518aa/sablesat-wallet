import { useEffect } from "react";
import { Platform } from "react-native";
import * as ScreenCapture from "expo-screen-capture";
import { logger } from "./logger";

// 防截屏 / 防录屏 / 防最近任务缩略图。
//
// 旧版本全项目没有任何截屏防护：助记词页、私钥页、PIN 输入页都可截屏，且会
// 进入 Android 最近任务缩略图和 iOS App Switcher 快照。

const activeTags = new Set<string>();

/**
 * 当前是否有敏感界面挂载（助记词 / 私钥 / 发送确认 / PIN 输入）。
 *
 * App.tsx 的 AppState 监听据此决定切后台时是否给 30 秒宽限期。改之前那里读的是
 * `sensitiveScreenRef`，而**全项目没有任何地方把它设为 true** —— "从敏感界面切
 * 后台立即锁定"整条逻辑是死代码，实际所有场景都吃满 30 秒宽限。
 *
 * 复用 useScreenGuard 已有的引用计数：需要防截屏的界面，和需要立即锁定的界面，
 * 是同一批。不必再维护第二套状态。
 */
export function isSensitiveScreenActive(): boolean {
  return activeTags.size > 0;
}

async function sync(): Promise<void> {
  try {
    if (activeTags.size > 0) {
      await ScreenCapture.preventScreenCaptureAsync("sablesat-sensitive");
    } else {
      await ScreenCapture.allowScreenCaptureAsync("sablesat-sensitive");
    }
  } catch (err) {
    // Expo Go / 模拟器上可能不支持；不阻断业务，但记录下来。
    logger.warn("Screen capture guard unavailable", err);
  }
}

/**
 * 敏感界面挂载期间禁止截屏。
 * @param tag 唯一标识，用于多个敏感组件同时挂载时的引用计数
 * @param enabled 传 false 可临时关闭（如内容尚未揭示时）
 */
export function useScreenGuard(tag: string, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    activeTags.add(tag);
    void sync();
    return () => {
      activeTags.delete(tag);
      void sync();
    };
  }, [tag, enabled]);
}

/** iOS 上截屏事件无法阻止，只能感知。用于在用户截图后提示风险。 */
export function useScreenshotWarning(onShot: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled || Platform.OS !== "ios") return;
    const sub = ScreenCapture.addScreenshotListener(onShot);
    return () => sub.remove();
  }, [onShot, enabled]);
}
