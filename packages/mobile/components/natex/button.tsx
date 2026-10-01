import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type ViewStyle,
} from "react-native";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Body, Label } from "./text";

/**
 * Buttons for a person wearing a helmet, holding a parcel, one-handed.
 *
 * design.md, "Mobile (Expo)": "The primary action on any screen is a
 * full-width button at least 56px tall, pinned to the bottom of the viewport,
 * reachable by the thumb of the hand holding the phone." So `primary` is
 * full-width and 56px by default and there is no small variant of it —
 * secondary actions are the ones allowed to be small, and even those never go
 * below the 48px minimum touch target.
 */

type Variant = "primary" | "secondary" | "danger" | "ghost";

interface ButtonProps extends Omit<PressableProps, "children" | "style"> {
  title: string;
  variant?: Variant;
  loading?: boolean;
  /** Shown under the title in 11px caps — the "why this is disabled" line. */
  hint?: string;
  icon?: React.ReactNode;
  style?: ViewStyle;
}

export function Button({
  title,
  variant = "primary",
  loading = false,
  hint,
  icon,
  disabled,
  style,
  ...rest
}: ButtonProps) {
  const colors = useColors();
  const isBlocked = disabled || loading;

  const palette: Record<Variant, { bg: string; fg: string; border: string }> = {
    primary: { bg: colors.primary, fg: colors.primaryForeground, border: colors.primary },
    secondary: { bg: colors.secondary, fg: colors.foreground, border: colors.border },
    danger: { bg: colors.statusWarn, fg: "#FFFFFF", border: colors.statusWarn },
    ghost: { bg: "transparent", fg: colors.mutedForeground, border: "transparent" },
  };
  const tone = palette[variant];

  return (
    <View>
      <Pressable
        {...rest}
        disabled={isBlocked}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: Boolean(isBlocked), busy: loading }}
        style={({ pressed }) => [
          styles.base,
          variant === "primary" ? styles.primarySize : styles.secondarySize,
          {
            backgroundColor: tone.bg,
            borderColor: tone.border,
            // No transforms: a pressed state that moves the button under a
            // gloved thumb reads as a missed tap.
            opacity: isBlocked ? 0.45 : pressed ? 0.85 : 1,
          },
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={tone.fg} />
        ) : (
          <>
            {icon}
            <Body color={tone.fg} style={styles.title}>
              {title}
            </Body>
          </>
        )}
      </Pressable>
      {hint ? <Label style={styles.hint}>{hint}</Label> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Space.unit,
    borderWidth: 1,
    borderRadius: Space.radius,
  },
  primarySize: {
    height: Space.primaryButtonHeight,
    paddingHorizontal: Space.page,
    width: "100%",
  },
  secondarySize: {
    minHeight: Space.minTouch,
    paddingHorizontal: Space.card,
    paddingVertical: Space.unit,
  },
  title: {
    fontFamily: Fonts.bodyMedium,
    fontSize: Type.body,
  },
  hint: { marginTop: 6, textAlign: "center" },
});
