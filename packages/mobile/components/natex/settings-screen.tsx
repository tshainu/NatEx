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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../../lib/api";
import { Input } from "./input";
import { flushRiderGps } from "../../lib/rider-gps";

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
    <Screen inTabs>
      <ScreenHeader
        title="Settings"
        subtitle={user ? `${user.name} | ${role ? humanise(role) : "Rider"} | ${user.branchName ?? "—"}` : undefined}
      />

      {role === "rider" ? <RiderAttendance /> : null}

      {/* ── Account ─────────────────────────────────────────────── */}
      {role !== "rider" ? <Section title="Account" icon="person-circle-outline">
        <Row label="Name" value={user?.name ?? "—"} />
        <Row label="Role" value={role ? humanise(role) : "—"} />
        <Row label="Branch" value={user?.branchName ?? "—"} last />
      </Section> : null}

      {/* ── Appearance ──────────────────────────────────────────── */}
      {role !== "rider" ? <Section title="Appearance" icon="contrast-outline">
        <ThemePicker />
      </Section> : null}

      {/* ── Scanning ────────────────────────────────────────────── */}
      {role !== "rider" ? <Section title="Scanning" icon="barcode-outline">
        <ScanSwitches />
      </Section> : null}

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

      <Button
        title="Sign out"
        variant="secondary"
        icon={<Ionicons name="log-out-outline" size={18} color={colors.foreground} />}
        onPress={async () => {
          await signOut();
          router.replace("/login");
        }}
      />
    </Screen>
  );
}

function RiderAttendance() {
  const { user } = useAuth();
  const colors = useColors();
  const queryClient = useQueryClient();
  const year = new Date().getFullYear();
  const status = useQuery({ ...orpc.hr.clockStatus.queryOptions({ input: {} }), refetchInterval: 10_000 });
  const summary = useQuery({ ...orpc.hr.riderAttendanceSummary.queryOptions({ input: { year } }) });
  const balances = useQuery({ ...orpc.hr.riderLeaveBalances.queryOptions({ input: { year } }) });
  const cash = useQuery({ ...orpc.cod.riderCash.queryOptions({ input: { riderId: user?.id ?? "" } }), enabled: Boolean(user?.id) });
  const [leaveTypeId, setLeaveTypeId] = React.useState("");
  const [startsOn, setStartsOn] = React.useState("");
  const [endsOn, setEndsOn] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [message, setMessage] = React.useState<string | null>(null);
  const clockIn = useMutation({ ...orpc.hr.clockIn.mutationOptions(), onSuccess: async () => { setMessage("Clock-in recorded and sent for HR approval."); await queryClient.invalidateQueries({ queryKey: orpc.hr.clockStatus.key() }); await queryClient.refetchQueries({ queryKey: orpc.hr.clockStatus.key() }); } });
  const clockOut = useMutation({ ...orpc.hr.clockOut.mutationOptions(), onSuccess: async () => { setMessage("Clock-out recorded. Your COD and delivery-charge settlement is shown below."); await queryClient.invalidateQueries({ queryKey: orpc.hr.clockStatus.key() }); await queryClient.refetchQueries({ queryKey: orpc.hr.clockStatus.key() }); void queryClient.invalidateQueries({ queryKey: orpc.cod.riderCash.key() }); } });
  const applyLeave = useMutation({ ...orpc.hr.riderApplyLeave.mutationOptions(), onSuccess: () => { setMessage("Leave request sent to HR for approval."); setReason(""); void queryClient.invalidateQueries({ queryKey: orpc.hr.riderLeaveBalances.key() }); } });
  const row = status.data?.row;
  const openSession = status.data?.openSession;
  const sessions = status.data?.sessions ?? [];
  const types = (balances.data ?? []).filter((item) => item.leaveTypeId);
  React.useEffect(() => { if (!leaveTypeId && types[0]?.leaveTypeId) setLeaveTypeId(types[0].leaveTypeId); }, [leaveTypeId, types]);
  return <Section title="Attendance & leave" icon="time-outline">
    <View style={styles.attendanceCard}><Body color={colors.mutedForeground}>Regular time 08:30–17:00 · short leave until 09:30 · half day until 12:30</Body><View style={styles.attendanceActions}>{!openSession ? <Button title="Clock in" loading={clockIn.isPending} onPress={() => clockIn.mutate({})} style={{ ...styles.smallAction, backgroundColor: colors.statusGood, borderColor: colors.statusGood }} /> : <Button title="Clock out" variant="danger" loading={clockOut.isPending} onPress={() => { void flushRiderGps(status.data?.workDate).catch(() => undefined).finally(() => clockOut.mutate({})); }} style={{ ...styles.smallAction, backgroundColor: "#DC2626", borderColor: "#DC2626" }} />}</View>{row ? <Small>Today: {sessions.length} session{sessions.length === 1 ? "" : "s"} · {row.clockInAt ? `first in ${new Date(row.clockInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "not clocked in"}{row.clockOutAt ? ` · last out ${new Date(row.clockOutAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · session open"} · {row.approvalStatus}</Small> : null}</View>
    <View style={styles.leaveSummary}>{types.slice(0, 4).map((item) => <View key={item.leaveTypeId} style={styles.leaveMetric}><Small>{item.leaveType}</Small><Body>{item.availableHalfDays / 2} d balance</Body></View>)}<View style={styles.leaveMetric}><Small>Short leave</Small><Body>{summary.data?.shortLeaveDays ?? 0} / 2</Body></View><View style={styles.leaveMetric}><Small>Half days</Small><Body>{summary.data?.halfDays ?? 0}</Body></View></View>
    <View style={styles.settlement}><Label>SETTLEMENT TO HUB</Label><Mono>Rs. {((cash.data?.liabilityCents ?? 0) / 100).toLocaleString()}</Mono><Small>COD collected plus delivery charges currently assigned to you.</Small></View>
    <View style={styles.leaveForm}><Label>APPLY LEAVE IN ADVANCE</Label><View style={styles.formGap}><Input label="Leave type" value={types.find((item) => item.leaveTypeId === leaveTypeId)?.leaveType ?? "Select a leave type"} editable={false} /><View style={styles.leaveTypeButtons}>{types.slice(0, 4).map((item) => <Pressable key={item.leaveTypeId} onPress={() => setLeaveTypeId(item.leaveTypeId)} style={[styles.leaveType, { borderColor: item.leaveTypeId === leaveTypeId ? colors.primary : colors.border }]}><Small>{item.leaveType}</Small></Pressable>)}</View><Input label="Start date" placeholder="YYYY-MM-DD" value={startsOn} onChangeText={setStartsOn} /><Input label="End date" placeholder="YYYY-MM-DD" value={endsOn} onChangeText={setEndsOn} /><Input label="Reason" value={reason} onChangeText={setReason} multiline /><Button title="Send leave request" loading={applyLeave.isPending} disabled={!leaveTypeId || !startsOn || !endsOn || !reason.trim() || Number.isNaN(Date.parse(startsOn)) || Number.isNaN(Date.parse(endsOn)) || Date.parse(endsOn) < Date.parse(startsOn)} onPress={() => { const days = Math.floor((Date.parse(endsOn) - Date.parse(startsOn)) / 86400000) + 1; applyLeave.mutate({ employeeId: "self", leaveTypeId, startsOn, endsOn, halfDays: days * 2, reason }); }} /></View></View>
    {message ? <Small color={colors.primary}>{message}</Small> : null}
  </Section>;
}

function MenuButton({ label, detail, onPress }: { label: string; detail: string; onPress: () => void }) {
  const colors = useColors();
  return <Pressable onPress={onPress} style={[styles.menuButton, { borderBottomColor: colors.border }]} accessibilityRole="button">
    <View style={styles.switchText}><Body>{label}</Body><Small>{detail}</Small></View>
    <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} />
  </Pressable>;
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
  const rejected = box.entries.filter((e) => e.state === "rejected").length;
  const conflicts = box.entries.filter((e) => e.state === "conflict").length;

  return (
    <>
      <Row
        label="Waiting to sync"
        value={plural(pending, "record")}
      />
      <Row
        label="Rejected — review Deliveries"
        value={plural(rejected, "record")}
      />
      <Row
        label="Needs ops"
        value={plural(conflicts, "record")}
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
  menuButton: {
    minHeight: Space.minTouch,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
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
  attendanceCard: { gap: 10, padding: 12, borderRadius: Space.radius, borderWidth: 1, borderColor: "rgba(16,185,129,0.72)", backgroundColor: "rgba(16,185,129,0.07)" },
  attendanceActions: { flexDirection: "row", gap: 8 },
  smallAction: { flex: 1 },
  leaveSummary: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: Space.unit },
  leaveMetric: { minWidth: "30%", flexGrow: 1, padding: 10, borderWidth: 1, borderColor: "rgba(128,128,128,0.25)", borderRadius: 10 },
  settlement: { gap: 6, paddingVertical: Space.unit },
  leaveForm: { gap: 10, marginTop: Space.unit },
  formGap: { gap: 10 },
  leaveTypeButtons: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  leaveType: { paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderRadius: 10 },
});
