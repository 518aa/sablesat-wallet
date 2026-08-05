export type Theme = {
  bg: string;
  card: string;
  surface: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  incoming: string;
  outgoing: string;
  warning: string;
  border: string;
  input: string;
  inputBorder: string;
  primaryButton: string;
  primaryButtonText: string;
  secondaryButton: string;
  secondaryButtonText: string;
  dangerBorder: string;
  dangerText: string;
  tabBg: string;
  tabActive: string;
  tabActiveText: string;
  tabInactiveText: string;
  sendGradient: [string, string];
  receiveGradient: [string, string];
};

export const sable: Theme = {
  bg: "#07090D",
  card: "#10151D",
  surface: "#1B2430",
  text: "#F7F2E8",
  textSecondary: "#C2BBB0",
  textMuted: "#9A9389",
  accent: "#D99A3D",
  incoming: "#2FB9A2",
  outgoing: "#E56B6F",
  warning: "#E8BE4B",
  border: "rgba(247,242,232,0.10)",
  input: "#0B1017",
  inputBorder: "rgba(247,242,232,0.15)",
  primaryButton: "#D99A3D",
  primaryButtonText: "#10151D",
  secondaryButton: "#253041",
  secondaryButtonText: "#F7F2E8",
  dangerBorder: "#E56B6F",
  dangerText: "#FFB4B8",
  tabBg: "rgba(16,21,29,0.96)",
  tabActive: "#D99A3D",
  tabActiveText: "#10151D",
  tabInactiveText: "#A7A19A",
  sendGradient: ["#D99A3D", "#C86C4F"],
  receiveGradient: ["#2FB9A2", "#3C7FB6"],
};

export const porcelain: Theme = {
  bg: "#F7F8FA",
  card: "#FFFFFF",
  surface: "#EAEFF5",
  text: "#171B22",
  textSecondary: "#5F6875",
  textMuted: "#667085",
  accent: "#B97922",
  incoming: "#0D8271",
  outgoing: "#C94F57",
  warning: "#A56D08",
  border: "#DCE3EC",
  input: "#FFFFFF",
  inputBorder: "#D2DAE5",
  primaryButton: "#171B22",
  primaryButtonText: "#FFFFFF",
  secondaryButton: "#E8F3F0",
  secondaryButtonText: "#176B58",
  dangerBorder: "#E3A09B",
  dangerText: "#B42318",
  tabBg: "#171B22",
  tabActive: "#E0A246",
  tabActiveText: "#171B22",
  tabInactiveText: "#D8E0EA",
  sendGradient: ["#B97922", "#D46B50"],
  receiveGradient: ["#2563A8", "#0D8271"],
};

export const aurora: Theme = {
  bg: "#071116",
  card: "#0E1B22",
  surface: "#172A33",
  text: "#F4FBF9",
  textSecondary: "#A9C2BE",
  textMuted: "#88A1A7",
  accent: "#7DD3C7",
  incoming: "#56D7A3",
  outgoing: "#F1767A",
  warning: "#F0C65A",
  border: "rgba(125,211,199,0.16)",
  input: "#09161C",
  inputBorder: "rgba(125,211,199,0.18)",
  primaryButton: "#7DD3C7",
  primaryButtonText: "#071116",
  secondaryButton: "#17313A",
  secondaryButtonText: "#DFFDF7",
  dangerBorder: "#F1767A",
  dangerText: "#FFB4B8",
  tabBg: "rgba(9,22,28,0.96)",
  tabActive: "#7DD3C7",
  tabActiveText: "#071116",
  tabInactiveText: "#8CA3A8",
  sendGradient: ["#E0A246", "#F1767A"],
  receiveGradient: ["#7DD3C7", "#4F8EC8"],
};

export const themes = { sable, porcelain, aurora } as const;

export const dark = sable;
export const light = porcelain;
