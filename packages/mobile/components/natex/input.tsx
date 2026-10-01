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
}

export const Input = React.forwardRef<TextInput, InputProps>(function Input(
  { label, hint, error, code = false, ...rest },
  ref,
) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      {label ? <Label>{label}</Label> : null}
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
          {
            color: colors.foreground,
            backgroundColor: colors.surface,
            borderColor: error ? colors.statusWarn : colors.border,
          },
        ]}
      />
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
