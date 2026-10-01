import React from "react";
import { StyleSheet, Text, type TextProps, type TextStyle } from "react-native";
import { Fonts, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * The type scale from design.md, as components rather than repeated style
 * objects. Nothing here goes below 14px except `Label`, which is the one 11px
 * uppercase size the design system allows.
 */

type Props = TextProps & { color?: string };

/** 11px uppercase, tracked — the only sub-14px size in the app. */
export function Label({ color, style, ...rest }: Props) {
  const colors = useColors();
  return (
    <Text
      {...rest}
      style={[styles.label, { color: color ?? colors.mutedForeground }, style]}
    />
  );
}

/** 24px display — screen titles. */
export function Display({ color, style, ...rest }: Props) {
  const colors = useColors();
  return <Text {...rest} style={[styles.display, { color: color ?? colors.foreground }, style]} />;
}

/** 18px — card and section titles. */
export function Title({ color, style, ...rest }: Props) {
  const colors = useColors();
  return <Text {...rest} style={[styles.title, { color: color ?? colors.foreground }, style]} />;
}

/** 15px body. */
export function Body({ color, style, ...rest }: Props) {
  const colors = useColors();
  return <Text {...rest} style={[styles.body, { color: color ?? colors.foreground }, style]} />;
}

/** 14px muted — supporting copy, never smaller. */
export function Small({ color, style, ...rest }: Props) {
  const colors = useColors();
  return (
    <Text {...rest} style={[styles.small, { color: color ?? colors.mutedForeground }, style]} />
  );
}

/**
 * Mono is **mandatory** for AWBs, seal numbers, device ids and money
 * (design.md). Tabular figures are what make a transposed digit visible.
 */
export function Mono({ color, style, ...rest }: Props) {
  const colors = useColors();
  return <Text {...rest} style={[styles.mono, { color: color ?? colors.foreground }, style]} />;
}

/**
 * The AWB as design.md pins it down for scan and confirm screens: 20px mono,
 * centred, above everything else. This is the thing a rider checks against a
 * physical label, so it gets its own component and its own size.
 */
export function Awb({ color, style, ...rest }: Props) {
  const colors = useColors();
  return (
    <Text
      {...rest}
      selectable
      style={[styles.awb, { color: color ?? colors.foreground }, style]}
    />
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: Fonts.bodyMedium,
    fontSize: Type.label,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  } as TextStyle,
  display: {
    fontFamily: Fonts.display,
    fontSize: Type.display,
    lineHeight: Type.display * 1.25,
  },
  title: {
    fontFamily: Fonts.displayMedium,
    fontSize: Type.title,
    lineHeight: Type.title * 1.3,
  },
  body: {
    fontFamily: Fonts.body,
    fontSize: Type.body,
    lineHeight: Type.body * 1.5,
  },
  small: {
    fontFamily: Fonts.body,
    fontSize: Type.small,
    lineHeight: Type.small * 1.45,
  },
  mono: {
    fontFamily: Fonts.mono,
    fontSize: Type.small,
    letterSpacing: 0.4,
  },
  awb: {
    fontFamily: Fonts.monoBold,
    fontSize: Type.awb,
    letterSpacing: 1.6,
    textAlign: "center",
  },
});
