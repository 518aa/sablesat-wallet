import * as Haptics from "expo-haptics";

// Thin, crash-safe wrapper so a missing/denied/unavailable haptics module
// never breaks a tap handler. Light = small UI ticks (tab switch, toggle);
// Medium = primary actions (send/receive, confirm); Heavy = destructive (delete).
type Impact = "light" | "medium" | "heavy";

const styleMap: Record<Impact, Haptics.ImpactFeedbackStyle> = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
};

// expo-haptics throws "not available on <platform>" when the native module is
// missing (e.g. an iOS build made before `pod install`, or the iOS Simulator).
// That surfaces two ways: a synchronous throw when the property is touched, AND
// a rejected promise from impactAsync/selectionAsync — so we guard both, and we
// evaluate the property access *inside* the try so a sync throw is also caught.
function safeCall(name: "impactAsync" | "selectionAsync", arg?: unknown): void {
  try {
    const fn = (Haptics as Record<string, unknown>)[name];
    if (typeof fn !== "function") return; // module/native unavailable → degrade
    const result = (fn as (a?: unknown) => unknown).call(Haptics, arg);
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {
        /* haptics is non-essential — swallow async rejection */
      });
    }
  } catch {
    /* synchronous throw — haptics unavailable, ignore */
  }
}

export function hapticImpact(impact: Impact = "light"): void {
  safeCall("impactAsync", styleMap[impact]);
}

export function hapticSelection(): void {
  safeCall("selectionAsync");
}
