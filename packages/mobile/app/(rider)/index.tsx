import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import React from "react";
import { Animated, Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { apiMessage, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, plural } from "../../lib/format";
import { useRiderRun } from "../../hooks/use-rider-run";
import { setThemePreference, useThemePreference } from "../../lib/theme";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

const MENU = [
  { label: "Delivery", detail: "Today’s active route", icon: "bicycle-outline" as const, href: "/(rider)/deliveries" },
  { label: "Pick-up", detail: "Merchant collection list", icon: "cube-outline" as const, href: "/(rider)" },
  { label: "Transport", detail: "Running chart and route", icon: "navigate-outline" as const, href: "/(rider)/route" },
  { label: "Over-time earning", detail: "Earnings will appear when available", icon: "cash-outline" as const, href: "/(rider)/day-registry" },
  { label: "Leave management", detail: "Attendance, balances and requests", icon: "calendar-outline" as const, href: "/(rider)/day-registry" },
  { label: "Running chart", detail: "View your GPS route", icon: "map-outline" as const, href: "/(rider)/route" },
  { label: "Enrol New Merchant", detail: "Submit a new merchant", icon: "storefront-outline" as const, href: "/(rider)/enroll-merchant" },
  { label: "Delivery history", detail: "Completed deliveries", icon: "time-outline" as const, href: "/(rider)/delivered" },
  { label: "Failed attempts", detail: "Review NDRs and reattempts", icon: "alert-circle-outline" as const, href: "/(rider)/failed-attempts" },
];

export default function RiderTodayScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const today = useQuery(orpc.collection.riderToday.queryOptions({ input: {} }));
  const runQuery = useRiderRun();
  const gps = useQuery(orpc.riderGps.own.queryOptions({ input: {} }));
  const attendance = useQuery({ ...orpc.hr.clockStatus.queryOptions({ input: {} }), refetchInterval: 60_000 });
  const leave = useQuery(orpc.hr.riderLeaveBalances.queryOptions({ input: { year: new Date().getFullYear() } }));
  const manifests = today.data?.manifests ?? [];
  const run = runQuery.data?.run;
  const delivered = run?.items.filter((item) => item.status === "Delivered").length ?? 0;
  const runTotal = run?.items.length ?? 0;
  const leaveDays = (leave.data ?? []).reduce((sum, row) => sum + ((row.availableHalfDays ?? 0) / 2), 0);
  const progress = runTotal ? delivered / runTotal : 0;
  const entrance = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    Animated.timing(entrance, { toValue: 1, duration: 520, useNativeDriver: true }).start();
  }, [entrance]);

  return (
    <Screen inTabs refreshing={today.isRefetching} onRefresh={() => { void today.refetch(); void runQuery.refetch(); void gps.refetch(); }}>
      <ScreenHeader
        title="Rider dashboard"
        subtitle={`${user?.name ?? "Rider"} · ${today.data ? date(today.data.pickupDate) : "Today"}`}
        right={<Pressable accessibilityLabel="Open rider menu" onPress={() => setDrawerOpen(true)} style={styles.menuButton}><Ionicons name="menu" size={25} color={colors.foreground} /></Pressable>}
      />

      <Animated.View style={{ opacity: entrance, transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }}>
        <Panel style={styles.hero}>
          <View style={styles.heroCopy}>
            <Label color={colors.primary}>YOUR SHIFT AT A GLANCE</Label>
            <Title>{attendance.data?.row?.clockInAt && !attendance.data.row.clockOutAt ? "On the road" : "Ready for your shift"}</Title>
            <Small>{today.data ? `${today.data.totals.pending} labels waiting to be scanned` : "Your live work summary will appear here."}</Small>
          </View>
          <View style={[styles.heroOrb, { backgroundColor: `${colors.primary}25` }]}><Ionicons name="flash" size={25} color={colors.primary} /></View>
        </Panel>
      </Animated.View>

      <Section style={styles.metricGrid}>
        <MetricCard label="Delivery" value={runTotal ? `${delivered}/${runTotal}` : "0"} detail={runTotal ? "stops complete" : "no route assigned"} icon="bicycle-outline" color={colors.primary} progress={progress} />
        <MetricCard label="Transport" value={`${((gps.data?.day?.distanceMeters ?? 0) / 1000).toFixed(1)} km`} detail="travelled today" icon="navigate-outline" color={colors.statusMoving} />
        <MetricCard label="Overtime" value="—" detail="not available yet" icon="cash-outline" color={colors.statusWarn} />
        <MetricCard label="Leave" value={`${leaveDays} d`} detail="available balance" icon="calendar-outline" color={colors.statusGood} />
      </Section>

      {today.isError ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(today.error, "Could not load today's pickups.")}</Body><Small>Pull down to try again.</Small></Panel> : null}
      {today.isPending ? <Small>Loading your pickup list…</Small> : null}
      {today.isSuccess && manifests.length === 0 ? <Empty title="Nothing assigned today" detail="Merchant bookings assigned to you by default and operations-scheduled pickups appear here." /> : null}
      {manifests.length > 0 ? <Section><View style={styles.sectionHeading}><Label>UPCOMING PICKUPS</Label><Pressable onPress={() => router.push("/(rider)")}><Small color={colors.primary}>See all</Small></Pressable></View>{manifests.slice(0, 3).map((row, index) => { const pending = row.expectedCount - row.scannedCount; return <Card key={row.id} onPress={() => router.push(`/(rider)/manifest/${row.id}`)} style={index === 0 ? { borderColor: colors.primary, borderWidth: 2 } : undefined}><View style={styles.cardTop}><View style={styles.flex}><Label color={index === 0 ? colors.primary : colors.mutedForeground}>{index === 0 ? "NEXT PICKUP" : `PICKUP ${index + 1}`}</Label><Title>{row.merchantName}</Title><Mono color={colors.mutedForeground}>{row.code}</Mono></View><LifecyclePill status={row.status} /></View><Small>{row.merchantAddress}</Small><View style={styles.cardBottom}><Badge tone={pending > 0 ? "warn" : "good"}>{pending > 0 ? `${plural(pending, "label")} left` : "All scanned"}</Badge>{row.codEnabled ? <Badge tone="brand">COD</Badge> : null}</View></Card>; })}</Section> : null}

      <RiderDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} userName={user?.name ?? "Rider"} branch={user?.branchName ?? "NatEx field team"} />
    </Screen>
  );
}

function MetricCard({ label, value, detail, icon, color, progress = 0 }: { label: string; value: string; detail: string; icon: keyof typeof Ionicons.glyphMap; color: string; progress?: number }) {
  const colors = useColors();
  return <Card style={styles.metricCard}><View style={[styles.metricIcon, { backgroundColor: `${color}22` }]}><Ionicons name={icon} size={19} color={color} /></View><Label>{label}</Label><Mono style={styles.metricValue}>{value}</Mono><Small>{detail}</Small>{progress > 0 ? <View style={[styles.metricTrack, { backgroundColor: colors.border }]}><View style={[styles.metricFill, { width: `${Math.round(progress * 100)}%`, backgroundColor: color }]} /></View> : null}</Card>;
}

function RiderDrawer({ visible, onClose, userName, branch }: { visible: boolean; onClose: () => void; userName: string; branch: string }) {
  const colors = useColors();
  const preference = useThemePreference();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalRoot}><Pressable style={styles.scrim} onPress={onClose} /><View style={[styles.drawer, { backgroundColor: colors.background }]}><ScrollView contentContainerStyle={styles.drawerContent} showsVerticalScrollIndicator={false}><View style={styles.drawerHandle} /><View style={styles.profile}><View style={[styles.avatar, { backgroundColor: colors.primary }]}><Body color={colors.primaryForeground}>{userName.slice(0, 1).toUpperCase()}</Body></View><View style={styles.flex}><Title>{userName}</Title><Small>{branch}</Small></View><Pressable accessibilityLabel="Close rider menu" onPress={onClose}><Ionicons name="close" size={23} color={colors.mutedForeground} /></Pressable></View><View style={[styles.menuDivider, { backgroundColor: colors.border }]} />{MENU.map((item) => <Pressable key={item.label} onPress={() => { onClose(); router.push(item.href); }} style={styles.drawerItem}><Ionicons name={item.icon} size={20} color={colors.primary} /><View style={styles.flex}><Body>{item.label}</Body><Small>{item.detail}</Small></View><Ionicons name="chevron-forward" size={17} color={colors.mutedForeground} /></Pressable>)}<View style={styles.drawerFooter}><Small>APPEARANCE</Small><View style={styles.themeRow}><Pressable onPress={() => void setThemePreference("dark")} style={[styles.themeChoice, { backgroundColor: preference === "dark" ? colors.primary : colors.secondary }]}><Ionicons name="moon-outline" size={16} color={preference === "dark" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "dark" ? colors.primaryForeground : colors.foreground}>Dark</Small></Pressable><Pressable onPress={() => void setThemePreference("day")} style={[styles.themeChoice, { backgroundColor: preference === "day" ? colors.primary : colors.secondary }]}><Ionicons name="sunny-outline" size={16} color={preference === "day" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "day" ? colors.primaryForeground : colors.foreground}>Light</Small></Pressable></View></View></ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  menuButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  hero: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Space.unit * 2, paddingVertical: Space.unit * 1.5 },
  heroCopy: { flex: 1, gap: 4 },
  heroOrb: { width: 58, height: 58, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit },
  metricCard: { width: "47.8%", minHeight: 152, padding: Space.unit * 1.25, gap: 4 },
  metricIcon: { width: 34, height: 34, borderRadius: 12, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  metricValue: { fontSize: 21, marginTop: 2 },
  metricTrack: { height: 5, borderRadius: 5, overflow: "hidden", marginTop: 5 },
  metricFill: { height: "100%", borderRadius: 5 },
  sectionHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit, marginTop: 2 },
  modalRoot: { flex: 1, flexDirection: "row" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.52)" },
  drawer: { width: "86%", maxWidth: 360, paddingTop: Space.page, paddingHorizontal: Space.page, paddingBottom: Space.page, elevation: 20, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 18 },
  drawerContent: { flexGrow: 1 },
  drawerHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 4, backgroundColor: "rgba(128,128,128,0.4)", marginBottom: Space.page },
  profile: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.25 },
  avatar: { width: 48, height: 48, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  menuDivider: { height: StyleSheet.hairlineWidth, marginVertical: Space.unit * 1.25 },
  drawerItem: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: Space.unit, paddingVertical: 5 },
  drawerFooter: { marginTop: "auto", gap: Space.unit },
  themeRow: { flexDirection: "row", gap: Space.unit },
  themeChoice: { flex: 1, minHeight: 40, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
});
