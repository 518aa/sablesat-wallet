// Theme-independent design tokens. Centralizing spacing, radii and a
// typography scale keeps every screen on the same rhythm instead of relying on
// ad-hoc magic numbers, which is what produced the inconsistent sizing we had.

export const radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

// Single source of truth for the "pressed" look so every tappable surface
// reacts the same way (one recipe, not four slightly different scales).
// scale 不低于 0.95：再小会让大按钮产生"塌陷"错觉。
export const press = {
  opacity: 0.82,
  scale: 0.96,
} as const;

// 等宽数字：金额刷新时避免字符宽度抖动。用法：style={[styles.x, tnum]}。
// 不用 as const：RN 的 FontVariant[] 要求可变数组。
export const tnum: { fontVariant: ("tabular-nums")[] } = { fontVariant: ["tabular-nums"] };

// Spread into a Text style, e.g. style={[styles.x, typo.h2]}.
// Weights are graded: big display/headings stay heavy, body/label/caption
// drop to regular/medium so hierarchy comes from size + weight, not just size.
export const typo = {
  display: { fontSize: 42, fontWeight: "800" as const, letterSpacing: -0.5 },
  h1: { fontSize: 28, fontWeight: "800" as const, letterSpacing: -0.3 },
  h2: { fontSize: 22, fontWeight: "800" as const, letterSpacing: -0.1 },
  h3: { fontSize: 18, fontWeight: "700" as const },
  title: { fontSize: 16, fontWeight: "800" as const },
  body: { fontSize: 14, fontWeight: "500" as const, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: "700" as const },
  caption: { fontSize: 11, fontWeight: "500" as const },
};

// Subtle elevation tuned for the dark surfaces. Reused by cards everywhere so
// depth reads consistently.
export const cardShadow = {
  shadowColor: "#000",
  shadowOpacity: 0.25,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 10 },
  elevation: 6,
} as const;
