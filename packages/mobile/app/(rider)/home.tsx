import { Ionicons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
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
  const year = new Date().getFullYear();
  const month = `${year}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const leave = useQuery(orpc.hr.riderLeaveBalances.queryOptions({ input: { year } }));
  const attendance = useQuery(orpc.hr.riderAttendanceSummary.queryOptions({ input: { year } }));
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
  const todayRun = run?.items ?? [];
  const todayDelivered = todayRun.filter((item) => item.status === "Delivered").length;
  const todayFailed = todayRun.filter((item) => item.status === "Failed").length;
  const leaveDays = (leave.data ?? []).reduce((sum, row) => sum + ((row.availableHalfDays ?? 0) / 2), 0);
  const overtimeMinutes = (attendance.data?.rows ?? [])
    .filter((row) => row.workDate.startsWith(month))
    .reduce((sum, row) => sum + (row.overtimeMinutes ?? 0), 0);
  const rowsByDate = new Map((performance.data ?? []).map((row) => [row.date, row]));
  const assigned = week.map((day) => rowsByDate.get(day)?.assignedCount ?? (day === week[6] ? todayRun.length : 0));
  const delivered = week.map((day) => rowsByDate.get(day)?.deliveredByCutoff ?? (day === week[6] ? todayDelivered : 0));
  const failed = week.map((day) => (day === week[6] ? todayFailed : 0));
  const dailyKm = gpsWeek.map((query) => (query.data?.day?.distanceMeters ?? 0) / 1000);
  const refresh = () => {
    void today.refetch();
    void runQuery.refetch();
    void leave.refetch();
    void attendance.refetch();
    void performance.refetch();
    gpsWeek.forEach((query) => void query.refetch());
  };

  return (
    <Screen inTabs refreshing={today.isRefetching} onRefresh={refresh}>
      <ScreenHeader title="Home" subtitle={`${user?.name ?? "Rider"} · ${today.data ? date(today.data.pickupDate) : "Today"}`} />

      <HeroPanel
        name={user?.name ?? "Rider"}
        assigned={todayRun.length}
        delivered={todayDelivered}
        failed={todayFailed}
        colors={colors}
      />

      <Section style={styles.kpiStrip}>
        <Kpi label="OT · MONTH" value={attendance.isSuccess ? `${(overtimeMinutes / 60).toFixed(1)} h` : "—"} icon="time-outline" color={colors.statusWarn} />
        <Kpi label="LEAVE · YEAR" value={leave.isSuccess ? `${leaveDays} d` : "—"} icon="calendar-outline" color={colors.statusGood} />
        <Kpi label="DISTANCE · TODAY" value={gpsWeek[6]?.isSuccess ? `${(dailyKm[6] ?? 0).toFixed(1)} km` : "—"} icon="navigate-outline" color={colors.statusMoving} />
      </Section>

      <Panel>
        <View style={styles.sectionHeading}>
          <View>
            <Label>DELIVERY PULSE</Label>
            <Title>Seven-day movement</Title>
          </View>
          <Badge tone={performance.isSuccess && performance.data?.length ? "good" : "muted"}>
            {performance.isSuccess && performance.data?.length ? "LIVE" : "NO SIGNAL"}
          </Badge>
        </View>
        <LineChart
          series={[
            { label: "Assigned", values: assigned, color: colors.mutedForeground },
            { label: "Delivered", values: delivered, color: colors.primary },
            { label: "Failed", values: failed, color: colors.statusWarn },
          ]}
          empty="No delivery performance recorded this week."
        />
      </Panel>

      <Panel>
        <View style={styles.sectionHeading}>
          <View>
            <Label>ROUTE LOAD</Label>
            <Title>Distance by day</Title>
          </View>
          <Mono color={colors.statusMoving}>{dailyKm.reduce((sum, value) => sum + value, 0).toFixed(1)} km</Mono>
        </View>
        <LineChart series={[{ label: "Kilometres", values: dailyKm, color: colors.statusMoving }]} empty="No accepted GPS points this week." />
      </Panel>

      {today.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>{apiMessage(today.error, "Could not load today's pickups.")}</Body>
        </Panel>
      ) : null}
      {today.isPending ? <Small>Loading your pickup list…</Small> : null}
      {today.isSuccess && manifests.length === 0 ? <Empty title="Nothing assigned today" detail="Merchant bookings and operations-scheduled pickups appear here." /> : null}
      {manifests.length > 0 ? (
        <Section>
          <View style={styles.sectionHeading}>
            <View>
              <Label>NEXT IN THE FIELD</Label>
              <Title>Today’s pickups</Title>
            </View>
            <Pressable onPress={() => router.push("/(rider)")}><Small color={colors.primary}>See all</Small></Pressable>
          </View>
          {manifests.slice(0, 3).map((row, index) => {
            const pending = row.expectedCount - row.scannedCount;
            return (
              <Card
                key={row.id}
                onPress={() => router.push(`/(rider)/manifest/${row.id}`)}
                style={index === 0 ? { borderColor: colors.primary, borderWidth: 2 } : undefined}
              >
                <View style={styles.cardTop}>
                  <View style={styles.flex}>
                    <Label color={index === 0 ? colors.primary : colors.mutedForeground}>{index === 0 ? "NEXT PICKUP" : `PICKUP ${index + 1}`}</Label>
                    <Title>{row.merchantName}</Title>
                    <Mono color={colors.mutedForeground}>{row.code}</Mono>
                  </View>
                  <LifecyclePill status={row.status} />
                </View>
                <Small>{row.merchantAddress}</Small>
                <View style={styles.cardBottom}>
                  <Badge tone={pending > 0 ? "warn" : "good"}>{pending > 0 ? `${plural(pending, "label")} left` : "All scanned"}</Badge>
                  {row.codEnabled ? <Badge tone="brand">COD</Badge> : null}
                </View>
              </Card>
            );
          })}
        </Section>
      ) : null}
    </Screen>
  );
}

function HeroPanel({ name, assigned, delivered, failed, colors }: { name: string; assigned: number; delivered: number; failed: number; colors: ReturnType<typeof useColors> }) {
  const completion = assigned > 0 ? Math.min(1, delivered / assigned) : 0;
  return (
    <View style={[styles.hero, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.heroGlow} />
      <View style={styles.heroContent}>
        <View style={styles.heroTop}>
          <View style={styles.flex}>
            <Small color={colors.primary}>FIELD CONTROL · TODAY</Small>
            <Title color={colors.foreground}>Keep the route moving, {name.split(" ")[0]}.</Title>
          </View>
          <View style={[styles.heroIcon, { backgroundColor: `${colors.primary}22` }]}><Ionicons name="radio-outline" size={22} color={colors.primary} /></View>
        </View>
        <RouteProgress completion={completion} failed={failed} colors={colors} />
        <View style={styles.heroStats}>
          <HeroStat label="ASSIGNED" value={assigned} colors={colors} />
          <HeroStat label="DELIVERED" value={delivered} colors={colors} />
          <HeroStat label="FAILED" value={failed} colors={colors} />
        </View>
      </View>
    </View>
  );
}

function RouteProgress({ completion, failed, colors }: { completion: number; failed: number; colors: ReturnType<typeof useColors> }) {
  const progressX = 14 + completion * 252;
  return (
    <View style={styles.routeVisual}>
      <Svg width="100%" height={46} viewBox="0 0 280 46">
        <Path d="M14 23 C58 4, 78 42, 122 23 S194 4, 266 23" fill="none" stroke={`${colors.mutedForeground}55`} strokeWidth="2" strokeDasharray="4 5" />
        <Line x1="14" y1="23" x2={progressX} y2="23" stroke={colors.primary} strokeWidth="4" strokeLinecap="round" />
        <Circle cx="14" cy="23" r="6" fill={colors.card} stroke={colors.primary} strokeWidth="3" />
        <Circle cx={progressX} cy="23" r="7" fill={colors.primary} />
        <Circle cx="266" cy="23" r="6" fill={colors.card} stroke={`${colors.mutedForeground}88`} strokeWidth="2" />
      </Svg>
      <View style={styles.routeLabels}><Small>START</Small><Small>{failed ? `${failed} NEED ATTENTION` : "ON TRACK"}</Small><Small>FINISH</Small></View>
    </View>
  );
}

function HeroStat({ label, value, colors }: { label: string; value: number; colors: ReturnType<typeof useColors> }) {
  return <View style={styles.heroStat}><Mono color={colors.foreground} style={styles.heroValue}>{value}</Mono><Small>{label}</Small></View>;
}

function Kpi({ label, value, icon, color }: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap; color: string }) {
  const colors = useColors();
  return <View style={[styles.kpi, { borderColor: colors.border, backgroundColor: colors.surface }]}><View style={[styles.kpiIcon, { backgroundColor: `${color}22` }]}><Ionicons name={icon} size={16} color={color} /></View><Small>{label}</Small><Mono style={styles.kpiValue}>{value}</Mono></View>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: { minHeight: 220, overflow: "hidden", borderWidth: 1, borderRadius: 28 },
  heroGlow: { position: "absolute", top: -70, right: -40, width: 220, height: 220, borderRadius: 110, backgroundColor: "rgba(16,185,129,0.12)" },
  heroContent: { padding: Space.page, gap: Space.unit * 1.5 },
  heroTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  heroIcon: { width: 42, height: 42, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  routeVisual: { marginTop: 2 },
  routeLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: -4 },
  heroStats: { flexDirection: "row", gap: Space.unit * 2 },
  heroStat: { flex: 1, gap: 2 },
  heroValue: { fontSize: 23 },
  kpiStrip: { flexDirection: "row", gap: Space.unit },
  kpi: { flex: 1, minHeight: 106, borderRadius: 18, borderWidth: 1, padding: 10, gap: 4 },
  kpiIcon: { width: 28, height: 28, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  kpiValue: { fontSize: 17, marginTop: 2 },
  sectionHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit, marginTop: 2 },
});
