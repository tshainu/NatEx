import React from "react";
import { Colors, type ColorScheme, type ThemeColors } from "../constants/theme";
import { useResolvedScheme } from "../lib/theme";

const ThemeOverrideContext = React.createContext<ColorScheme | null>(null);

/** Lets a role-specific route group use a fixed palette without changing the device preference. */
export function ThemeOverrideProvider({
  children,
  scheme,
}: {
  children: React.ReactNode;
  scheme: ColorScheme;
}) {
  return React.createElement(ThemeOverrideContext.Provider, { value: scheme }, children);
}

/** Returns the route override when present, otherwise the user's saved appearance preference. */
export function useColors(): ThemeColors {
  const resolved = useResolvedScheme();
  const override = React.useContext(ThemeOverrideContext);
  return Colors[override ?? resolved];
}
