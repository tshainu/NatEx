import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useOutbox } from "../../hooks/use-rider-run";
import { drain } from "../../lib/outbox";
import { plural, since } from "../../lib/format";
import { Label, Small } from "./text";

/**
 * One line that answers "is my work safe?" — the question a rider asks every
 * time the signal bar drops. design.md: state is a word, never a bare dot.
 */
export function SyncStrip() {
  const colors = useColors();
  const box = useOutbox();
  const pending = box.entries.filter((e) => e.state === "pending").length;
  const problems = box.entries.filter((e) => e.state === "rejected" || e.state === "conflict").length;

  const tone = problems > 0 ? colors.statusWarn : box.offline || pending > 0 ? colors.statusMoving : colors.statusGood;
  const headline = box.draining
    ? "Syncing…"
    : problems > 0
      ? `${plural(problems, "record")} ${problems === 1 ? "needs" : "need"} ops`
      : box.offline
        ? pending > 0
          ? `Offline · ${plural(pending, "record")} saved on phone`
          : "Offline"
        : pending > 0
          ? `${plural(pending, "record")} waiting to sync`
          : "All records synced";
  const detail = box.lastContactAt
    ? `Last synced ${since(box.lastContactAt)}`
    : box.lastDrainAt
      ? "Not synced yet this session"
      : "Checking connection…";

  return (
    <View
      testID="sync-strip"
      style={[styles.strip, { borderColor: `${tone}66`, backgroundColor: `${tone}1F` }]}
    >
      <Ionicons
        name={box.offline ? "cloud-offline-outline" : pending > 0 ? "cloud-upload-outline" : "cloud-done-outline"}
        size={22}
        color={tone}
      />
      <View style={styles.flex}>
        <Label color={tone}>{headline}</Label>
        <Small>{detail}</Small>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sync now"
        disabled={box.draining}
        onPress={() => void drain()}
        style={styles.action}
      >
        <Label color={colors.primary}>{box.draining ? "…" : "Sync now"}</Label>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit * 1.5,
    borderWidth: 1,
    borderRadius: Space.radius,
    paddingHorizontal: Space.unit * 1.5,
    paddingVertical: Space.unit,
  },
  flex: { flex: 1, gap: 2 },
  action: {
    minHeight: Space.minTouch,
    minWidth: Space.minTouch,
    justifyContent: "center",
    alignItems: "flex-end",
  },
});
