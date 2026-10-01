import React from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Body, Label, Mono, Small, Title } from "./text";

/**
 * Cards and rows. On a phone every list is a stack of cards, because a table
 * with five columns on a 6-inch screen is a table nobody reads.
 *
 * design.md: "One question per screen." A card answers one question and, when
 * it is tappable, leads to the screen that acts on it.
 */

export function Card({
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const colors = useColors();
  const body = (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        style,
      ]}
    >
      {children}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}
    >
      {body}
    </Pressable>
  );
}

/** A quieter panel: notes, empty states, explanatory blocks. */
export function Panel({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const colors = useColors();
  return (
    <View
      style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }, style]}
    >
      {children}
    </View>
  );
}

/** Label above, value below — the standard detail row. `mono` for AWB/seal/money. */
export function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      {mono ? <Mono>{value ?? "—"}</Mono> : <Body>{value ?? "—"}</Body>}
    </View>
  );
}

/** Big number with a caption — the dashboard-header counters. */
export function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) {
  const colors = useColors();
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Title color={color}>{String(value)}</Title>
      <Label>{label}</Label>
    </View>
  );
}

/** Row of stats that wraps rather than shrinking numbers below readable size. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.statRow}>{children}</View>;
}

/** What a screen shows when there is genuinely nothing to do. */
export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <Panel style={styles.empty}>
      <Body>{title}</Body>
      {detail ? <Small style={styles.emptyDetail}>{detail}</Small> : null}
    </Panel>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: Space.radius,
    padding: Space.card,
    gap: Space.unit,
  },
  panel: {
    borderWidth: 1,
    borderRadius: Space.radius,
    padding: Space.card,
    gap: 6,
  },
  field: { gap: 4 },
  stat: {
    flexGrow: 1,
    flexBasis: "30%",
    borderWidth: 1,
    borderRadius: Space.radius,
    padding: Space.unit * 1.5,
    gap: 4,
  },
  statRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Space.unit,
  },
  empty: { alignItems: "center", paddingVertical: Space.page },
  emptyDetail: { textAlign: "center" },
});
