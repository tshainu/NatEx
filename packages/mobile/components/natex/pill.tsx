import React from "react";
import { StyleSheet, View } from "react-native";
import { Space, lifecycleColor, statusColor } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { humanise } from "../../lib/format";
import { Label } from "./text";

/**
 * StatusPill, per design.md: "11px uppercase, 999px radius, 1px border in the
 * status colour at 40% with a 12% fill. Never a bare coloured dot; the word must
 * be readable."
 *
 * React Native has no colour-mix function, so the border and fill are the same
 * hex with an alpha suffix — `#RRGGBBAA` is supported by RN's colour parser.
 */

function tint(hex: string, alphaByte: string): string {
  // Only 6-digit hex reaches here (all tokens in constants/theme.ts are).
  return `${hex}${alphaByte}`;
}

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <View
      style={[
        styles.pill,
        { borderColor: tint(color, "66"), backgroundColor: tint(color, "1F") },
      ]}
    >
      <Label color={color}>{text}</Label>
    </View>
  );
}

/** A parcel status — colours locked to the design.md status table. */
export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <Pill text={humanise(status)} color={statusColor(status)} />;
}

/**
 * A bag / trip / manifest lifecycle value (open, sealed, in_transit, …). Not a
 * parcel status, but read with the same eyes, so it borrows the same palette.
 */
export function LifecyclePill({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <Pill text={humanise(status)} color={lifecycleColor(status)} />;
}

/** A neutral or explicitly-coloured count/flag pill. */
export function Badge({
  children,
  tone = "muted",
}: {
  children: string;
  tone?: "muted" | "brand" | "good" | "warn" | "bad";
}) {
  const colors = useColors();
  const color =
    tone === "brand"
      ? colors.primary
      : tone === "good"
        ? colors.statusGood
        : tone === "warn"
          ? colors.statusWarn
          : tone === "bad"
            ? colors.statusBad
            : colors.mutedForeground;
  return <Pill text={children} color={color} />;
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: Space.radiusPill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
});
