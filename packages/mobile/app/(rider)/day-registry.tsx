import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Panel } from "../../components/natex/card";
import { Body, Label, Mono, Small } from "../../components/natex/text";
import { Button } from "../../components/natex/button";
import { useAuth } from "../../lib/auth";
import { orpc } from "../../lib/api";
import { useQuery } from "@tanstack/react-query";
import { useColors } from "../../hooks/use-colors";

export default function DayRegistryScreen() {
  const { user } = useAuth(); const colors = useColors(); const year = new Date().getFullYear();
  const attendance = useQuery({ ...orpc.hr.riderAttendanceSummary.queryOptions({ input: { year } }) });
  const cash = useQuery({ ...orpc.cod.riderCash.queryOptions({ input: { riderId: user?.id ?? "" } }), enabled: Boolean(user?.id) });
  return <Screen><ScreenHeader title="Day registry" subtitle="Your attendance, leave counters and end-of-day liability" />
    {attendance.isPending ? <ActivityIndicator color={colors.primary} /> : <>
      <Panel><Label>LEAVE POLICY · {year}</Label><View style={styles.grid}><Stat label="Short leave" value={`${attendance.data?.shortLeaveDays ?? 0} / 2 monthly`} /><Stat label="Half days" value={String(attendance.data?.halfDays ?? 0)} /><Stat label="Full leave days" value={String(attendance.data?.fullLeaveDays ?? 0)} /></View><Small>2 short leave = 1 half day · 2 half days = 1 day · 2 short + 1 half day = 1 day</Small></Panel>
      <Panel><Label>SETTLEMENT AT LAST CHECK</Label><Mono style={styles.amount}>Rs. {((cash.data?.liabilityCents ?? 0) / 100).toLocaleString()}</Mono><Small>COD and delivery-charge collections currently assigned to you.</Small></Panel>
      <Panel><Label>RECENT ATTENDANCE</Label>{(attendance.data?.rows ?? []).slice(0, 20).map((row) => <View key={row.id} style={styles.row}><Body>{row.workDate}</Body><Small>{row.clockInAt ? new Date(row.clockInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"} → {row.clockOutAt ? new Date(row.clockOutAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"} · {row.approvalStatus}</Small></View>)}{!(attendance.data?.rows?.length) ? <Small>No attendance records yet.</Small> : null}</Panel>
    </>}
  </Screen>;
}
function Stat({ label, value }: { label: string; value: string }) { return <View style={styles.stat}><Small>{label}</Small><Body style={styles.statValue}>{value}</Body></View>; }
const styles = StyleSheet.create({ grid: { flexDirection: "row", gap: 8, marginVertical: 14 }, stat: { flex: 1, padding: 10, borderRadius: 12, backgroundColor: "rgba(128,128,128,0.1)" }, statValue: { marginTop: 4 }, row: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(128,128,128,0.3)" }, amount: { fontSize: 28, marginVertical: 12 }, });
