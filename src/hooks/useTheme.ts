import { createContext, useContext } from "react";
import type { Theme } from "../theme";

export type ThemeMode = "sable" | "porcelain" | "aurora";

export type ThemeContextType = {
  theme: Theme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
};

export const ThemeContext = createContext<ThemeContextType>({
  theme: {} as Theme,
  mode: "sable",
  setMode: () => {},
  toggle: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}
