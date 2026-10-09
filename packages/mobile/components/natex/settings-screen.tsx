import React from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";
import { router } from "expo-router";
import Constants from "expo-constants";
import { Ionicons } from "@expo/vector-icons";
import { Screen, ScreenHeader } from "./screen";
import { Button } from "./button";
import { Panel } from "./card";
import { Body, Label, Mono, Small } from "./text";
import { useAuth } from "../../lib/auth";
import { deviceId } from "../../lib/session";
import { humanise, plural } from "../../lib/format";
import { setThemePreference, useThemePreference, type ThemePreference } from "../../lib/theme";
import { updateSettings, useSettings } from "../../lib/settings";
import { useOutbox } from "../../hooks/use-rider-run";
import { drain } from "../../lib/outbox";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * The Settings tab, shared by both role groups — a rider and a transport
 * clerk tune the same things on the device, so the screen exists once.
 *
 * Sections: Account · Appearance · Scanning · Sync (rider only, the outbox is
 * theirs) · This device · About. Sign-out stays pinned to the footer, thumb-
 * reachable like every other primary action (design.md).
 */
export function SettingsScreen({ note }: { note?: string }) {
  const { user, role, signOut } = useAuth();
  const colors = useColors();

  return (
    <Screen
      inTabs
      footer={
        <Button
          title="Sign out"
          variant="secondary"
          icon={<Ionicons name="log-out-outline" size={18} color={colors.foreground} />}
          onPress={async () => {
            await signOut();
            router.replace("/login");
          }}
        />
      }
    >
      <ScreenHeader
        title="Settings"
        subtitle={user ? `${user.name} · ${role ? humanise(role) : ""}` : undefined}
      />

      {/* ── Account ─────────────────────────────────────────────── */}
      <Section title="Account" icon="person-circle-outline">
        <Row label="Name" value={user?.name ?? "—"} />
        <Row label="Role" value={role ? humanise(role) : "—"} />
        <Row label="Branch" value={user?.branchName ?? "—"} last />
      </Section>

      {/* ── Appearance ──────────────────────────────────────────── */}
      <Section title="Appearance" icon="contrast-outline">
        <ThemePicker />
      </Section>

      {/* ── Scanning ────────────────────────────────────────────── */}
      <Section title="Scanning" icon="barcode-outline">
        <ScanSwitches />
      </Section>

      {/* ── Sync — rider only; transport has no offline outbox ───── */}
      {role === "rider" ? (
        <Section title="Sync" icon="cloud-upload-outline">
          <SyncRows />
        </Section>
      ) : null}

      {/* ── This device ─────────────────────────────────────────── */}
      <Section title="This device" icon="phone-portrait-outline">
        <Row label="Device id" value={deviceId()} mono />
        {user?.deviceId ? <Row label="Bound device" value={user.deviceId} mono /> : null}
        <Small style={styles.deviceNote}>
          Signing in on another phone moves your account to it and ends this session.
        </Small>
      </Section>

      {note ? (
        <Panel>
          <Body>{note}</Body>
        </Panel>
      ) : null}

      {/* ── About ───────────────────────────────────────────────── */}
      <Section title="About" icon="information-circle-outline">
        <Row label="App version" value={Constants.expoConfig?.version ?? "—"} last />
      </Section>
    </Screen>
  );
}

/* ── Building blocks ─────────────────────────────────────────────────────── */

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
}) {
  const colors = useColors();
  return (
    <Panel>
      <View style={styles.sectionHead}>
        <Ionicons name={icon} size={16} color={colors.mutedForeground} />
        <Label>{title}</Label>
      </View>
      {children}
    </Panel>
  );
}

/** One settings row: label left, value right, hairline between rows. */
function Row({
  label,
  value,
  mono,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <Body color={colors.mutedForeground}>{label}</Body>
      {mono ? (
        <Mono style={styles.rowValue}>{value}</Mono>
      ) : (
        <Body style={styles.rowValue}>{value}</Body>
      )}
    </View>
  );
}

/** A row whose right side is a switch. */
function SwitchRow({
  label,
  hint,
  value,
  onChange,
  last,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
  last?: boolean;
}) {
  const colors = useColors();
  return (
    <View style={[styles.row, !last && { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <View style={styles.switchText}>
        <Body>{label}</Body>
        <Small>{hint}</Small>
      </View>
      <Switch
        value={value}
        onValueChange={(next) => void onChange(next)}
        trackColor={{ false: colors.border, true: colors.primary }}
        thumbColor={value ? colors.primary : colors.mutedForeground}
        accessibilityLabel={label}
      />
    </View>
  );
}

/* ── Appearance ──────────────────────────────────────────────────────────── */

const THEME_OPTIONS: { key: ThemePreference; title: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "dark", title: "Dark", icon: "moon-outline" },
  { key: "day", title: "Light", icon: "sunny-outline" },
];

/** Compact Dark / Light controls. The preference persists across launches. */
function ThemePicker() {
  const colors = useColors();
  const preference = useThemePreference();

  return (
    <View style={styles.segmentRow}>
      {THEME_OPTIONS.map((option) => {
        const active = preference === option.key;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => void setThemePreference(option.key)}
            style={[
              styles.segment,
              {
                backgroundColor: active ? colors.primary : colors.secondary,
                borderColor: active ? colors.primary : colors.border,
              },
            ]}
          >
            <Ionicons
              name={option.icon}
              size={19}
              color={active ? colors.primaryForeground : colors.mutedForeground}
            />
            <Body color={active ? colors.primaryForeground : colors.foreground}>
              {option.title}
            </Body>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── Scanning ────────────────────────────────────────────────────────────── */

function ScanSwitches() {
  const settings = useSettings();
  return (
    <>
      <SwitchRow
        label="Vibrate on scan"
        hint="Short pulse when a label is read"
        value={settings.vibrateOnScan}
        onChange={(vibrateOnScan) => updateSettings({ vibrateOnScan })}
      />
      <SwitchRow
        label="Torch while scanning"
        hint="Keeps the flash on in dark stairwells"
        value={settings.scannerTorch}
        onChange={(scannerTorch) => updateSettings({ scannerTorch })}
        last
      />
    </>
  );
}

/* ── Sync (rider) ────────────────────────────────────────────────────────── */

function SyncRows() {
  const colors = useColors();
  const box = useOutbox();
  const pending = box.entries.filter((e) => e.state === "pending").length;
  const problems = box.entries.filter((e) => e.state === "rejected" || e.state === "conflict").length;

  return (
    <>
      <Row
        label="Waiting to sync"
        value={plural(pending, "record")}
      />
      <Row
        label="Needs ops"
        value={plural(problems, "record")}
        last
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sync now"
        disabled={box.draining || pending === 0}
        onPress={() => void drain()}
        style={[styles.syncButton, { borderColor: colors.border, opacity: box.draining || pending === 0 ? 0.45 : 1 }]}
      >
        <Ionicons name="sync" size={16} color={colors.primary} />
        <Body color={colors.primary}>{box.draining ? "Syncing…" : "Sync now"}</Body>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: Space.unit,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Space.card,
    minHeight: Space.minTouch,
    paddingVertical: 6,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: "right",
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  segmentRow: { flexDirection: "row", gap: Space.unit },
  segment: {
    flex: 1,
    minHeight: Space.minTouch,
    borderRadius: Space.radius,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: Space.unit,
    gap: Space.unit,
  },
  syncButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: Space.minTouch,
    borderRadius: Space.radius,
    borderWidth: 1,
    marginTop: Space.unit,
  },
  deviceNote: {
    marginTop: 6,
    fontFamily: Fonts.body,
    fontSize: Type.small,
  },
});
