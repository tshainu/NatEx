import { Colors, type ThemeColors } from "../constants/theme";
import { useResolvedScheme } from "../lib/theme";

/**
 * Returns the color palette for the active appearance — the rider's Dark /
 * Day / System choice from the Me tab (lib/theme.ts), resolved against the OS
 * scheme when set to System.
 *
 * ```tsx
 * const colors = useColors();
 * <View style={{ backgroundColor: colors.background }}>
 *   <Text style={{ color: colors.foreground }}>Hello</Text>
 * </View>
 * ```
 */
export function useColors(): ThemeColors {
  const scheme = useResolvedScheme();
  return Colors[scheme];
}
