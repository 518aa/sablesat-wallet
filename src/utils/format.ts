import type { Language } from "../i18n";

export function localeFor(language: Language) {
  return language === "zh" ? "zh-CN" : "en-US";
}

export function formatCny(value: number, language: Language, maximumFractionDigits = 2) {
  return value.toLocaleString(localeFor(language), { maximumFractionDigits });
}
