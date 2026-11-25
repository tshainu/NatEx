import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { LineChart } from "../../components/natex/line-chart";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { apiMessage, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, plural } from "../../lib/format";
import { useRiderRun } from "../../hooks/use-rider-run";

function recentDays(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - count + 1 + index);
    return day.toISOString().slice(0, 10);
  });
}

export default function RiderTodayScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const today = useQuery(orpc.collection.riderToday.queryOptions({ input: {} }));
  const runQuery = useRiderRun();
  const run = runQuery.data?.run;
  const leave = useQuery(orpc.hr.riderLeaveBalances.queryOptions({ input: { year: new Date().getFullYear() } }));
  const week = recentDays(7);
  const gpsWeek = useQueries({
    queries: week.map((workDate) => orpc.riderGps.own.queryOptions({ input: { workDate } })),
  });
  const performance = useQuery({
    ...orpc.deliveryPerformance.riderDailyPerformance.queryOptions({
      input: { fromDate: week[0], toDate: week[6], riderId: user?.id },
    }),
    enabled: Boolean(user?.id),
  });
  const manifests = today.data?.manifests ?? [];
  const todayGps = gpsWeek[6]?.data;
  const todayRun = run?.items ?? [];
  const todayDelivered = todayRun.filter((item) => item.status === "Delivered").length;
  const todayFailed = todayRun.filter((item) => item.status === "Failed").length;
  const leaveDays = (leave.data ?? []).reduce((sum, row) => sum + ((row.availableHalfDays ?? 0) / 2), 0);
  const rowsByDate = new Map((performance.data ?? []).map((row) => [row.date, row]));
  const assigned = week.map((day) => rowsByDate.get(day)?.assignedCount ?? (day === week[6] ? todayRun.length : 0));
  const delivered = week.map((day) => rowsByDate.get(day)?.deliveredByCutoff ?? (day === week[6] ? todayDelivered : 0));
  const failed = week.map((day) => day === week[6] ? todayFailed : 0);
  const dailyKm = gpsWeek.map((query) => (query.data?.day?.distanceMeters ?? 0) / 1000);

  return (
    <Screen inTabs refreshing={today.isRefetching} onRefresh={() => { void today.refetch(); void runQuery.refetch(); void leave.refetch(); void performance.refetch(); gpsWeek.forEach((query) => void query.refetch()); }}>
      <ScreenHeader title="Home" subtitle={`${user?.name ?? "Rider"} · ${today.data ? date(today.data.pickupDate) : "Today"}`} />
      <Section style={styles.metricGrid}>
        <MetricCard label="OT hours this month" value="—" detail="Not available yet" icon="time-outline" color={colors.statusWarn} />
        <MetricCard label="Leave balance this year" value={`${leaveDays} d`} detail="Available balance" icon="calendar-outline" color={colors.statusGood} />
        <MetricCard label="Assigned today" value={`${todayRun.length}`} detail="Stops on route" icon="bicycle-outline" color={colors.primary} />
        <MetricCard label="Travelled today" value={`${(dailyKm[6] ?? 0).toFixed(1)} km`} detail="Accepted GPS" icon="navigate-outline" color={colors.statusMoving} />
      </Section>
      <Panel>
        <View style={styles.sectionHeading}><Label>THIS WEEK’S DELIVERIES</Label><Small>{todayDelivered} delivered · {todayFailed} failed today</Small></View>
        <LineChart series={[{ label: "Assigned", values: assigned, color: colors.mutedForeground }, { label: "Delivered", values: delivered, color: colors.primary }, { label: "Failed", values: failed, color: colors.statusWarn }]} empty="No delivery performance recorded this week." />
      </Panel>
      <Panel>
        <View style={styles.sectionHeading}><Label>DAILY KM RUN</Label><Small>Accepted GPS distance</Small></View>
        <LineChart series={[{ label: "Kilometres", values: dailyKm, color: colors.statusMoving }]} empty="No accepted GPS points this week." />
      </Panel>
      {today.isError ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(today.error, "Could not load today's pickups.")}</Body></Panel> : null}
      {today.isPending ? <Small>Loading your pickup list…</Small> : null}
      {today.isSuccess && manifests.length === 0 ? <Empty title="Nothing assigned today" detail="Merchant bookings and operations-scheduled pickups appear here." /> : null}
      {manifests.length > 0 ? <Section><View style={styles.sectionHeading}><Label>UPCOMING PICKUPS</Label><Pressable onPress={() => router.push("/(rider)")}><Small color={colors.primary}>See all</Small></Pressable></View>{manifests.slice(0, 3).map((row, index) => { const pending = row.expectedCount - row.scannedCount; return <Card key={row.id} onPress={() => router.push(`/(rider)/manifest/${row.id}`)} style={index === 0 ? { borderColor: colors.primary, borderWidth: 2 } : undefined}><View style={styles.cardTop}><View style={styles.flex}><Label color={index === 0 ? colors.primary : colors.mutedForeground}>{index === 0 ? "NEXT PICKUP" : `PICKUP ${index + 1}`}</Label><Title>{row.merchantName}</Title><Mono color={colors.mutedForeground}>{row.code}</Mono></View><LifecyclePill status={row.status} /></View><Small>{row.merchantAddress}</Small><View style={styles.cardBottom}><Badge tone={pending > 0 ? "warn" : "good"}>{pending > 0 ? `${plural(pending, "label")} left` : "All scanned"}</Badge>{row.codEnabled ? <Badge tone="brand">COD</Badge> : null}</View></Card>; })}</Section> : null}
    </Screen>
  );
}

function MetricCard({ label, value, detail, icon, color }: { label: string; value: string; detail: string; icon: keyof typeof Ionicons.glyphMap; color: string }) {
  return <Card style={styles.metricCard}><View style={[styles.metricIcon, { backgroundColor: `${color}22` }]}><Ionicons name={icon} size={18} color={color} /></View><Label>{label}</Label><Mono style={styles.metricValue}>{value}</Mono><Small>{detail}</Small></Card>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit },
  metricCard: { width: "47.8%", minHeight: 132, padding: Space.unit * 1.25, gap: 4 },
  metricIcon: { width: 32, height: 32, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  metricValue: { fontSize: 20, marginTop: 2 },
  sectionHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit, marginTop: 2 },
});
