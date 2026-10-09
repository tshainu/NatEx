import React from "react";
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Label, Small } from "./text";

/**
 * Text inputs sized for gloved thumbs (48px minimum) and, for the AWB and seal
 * fields, in 20px mono with auto-capitalisation off — the server normalises an
 * AWB by trimming and upper-casing, and the field shows the person exactly the
 * characters that will be sent.
 */

interface InputProps extends Omit<TextInputProps, "style"> {
  label?: string;
  /** Validation or explanation line under the field. */
  hint?: string;
  error?: string | null;
  /** AWB / seal / phone: mono, larger, no autocorrect. */
  code?: boolean;
  /** Optional control rendered inside the trailing edge of the input. */
  trailing?: React.ReactNode;
}

export const Input = React.forwardRef<React.ComponentRef<typeof TextInput>, InputProps>(function Input(
  { label, hint, error, code = false, trailing, ...rest },
  ref,
) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      {label ? <Label>{label}</Label> : null}
      <View style={styles.inputWrap}>
        <TextInput
          ref={ref}
          {...rest}
          placeholderTextColor={colors.mutedForeground}
          autoCorrect={code ? false : rest.autoCorrect}
          autoCapitalize={code ? "characters" : rest.autoCapitalize}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          style={[
            styles.input,
            code ? styles.code : styles.text,
            trailing ? styles.inputWithTrailing : null,
            {
              color: colors.foreground,
              backgroundColor: colors.surface,
              borderColor: error ? colors.statusWarn : colors.border,
            },
          ]}
        />
        {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {error ? (
        <Small color={colors.statusWarn}>{error}</Small>
      ) : hint ? (
        <Small>{hint}</Small>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  inputWrap: { position: "relative" },
  inputWithTrailing: { paddingRight: Space.minTouch + Space.unit },
  trailing: {
    position: "absolute",
    top: 0,
    right: 2,
    bottom: 0,
    justifyContent: "center",
  },
  input: {
    minHeight: Space.minTouch,
    borderWidth: 1,
    borderRadius: Space.radius,
    paddingHorizontal: Space.card,
    paddingVertical: Space.unit * 1.5,
  },
  text: {
    fontFamily: Fonts.body,
    fontSize: Type.body,
  },
  code: {
    fontFamily: Fonts.monoBold,
    fontSize: Type.awb,
    letterSpacing: 1.4,
    textAlign: "center",
  },
});
