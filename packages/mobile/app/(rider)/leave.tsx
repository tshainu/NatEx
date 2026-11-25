import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Pressable } from "react-native";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Panel } from "../../components/natex/card";
import { Body, Label, Small } from "../../components/natex/text";
import { orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";
export default function RiderLeaveScreen() {
  const colors = useColors(); const year = new Date().getFullYear();
  const balances = useQuery(orpc.hr.riderLeaveBalances.queryOptions({ input: { year } }));
  return <Screen><ScreenHeader title="Leave management" subtitle="Balances, history and requests" /><Panel><Label>LEAVE BALANCES · {year}</Label>{(balances.data ?? []).map((item) => <Panel key={item.leaveTypeId} style={styles.leaveRow}><Body>{item.leaveType}</Body><Small>Allocated: {item.entitlementHalfDays / 2} days · Used: {item.usedHalfDays / 2} days · Balance: {item.availableHalfDays / 2} days</Small></Panel>)}{!(balances.data ?? []).length ? <Small>No leave balance records available.</Small> : null}</Panel><Pressable onPress={() => router.replace("/(rider)/settings")}><Panel><Body color={colors.primary}>Apply leave and view attendance</Body><Small>Open Attendance & leave in Settings</Small></Panel></Pressable></Screen>;
}

const styles = { leaveRow: { paddingVertical: 10, marginTop: 8 } };
