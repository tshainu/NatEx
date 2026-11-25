import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Card, Panel } from "../../components/natex/card";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";

function isoDate(value: Date) { return value.toISOString().slice(0, 10); }
function time(value?: string | Date | null) { return value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"; }

export default function RiderRouteScreen() {
  const colors = useColors();
  const [selected, setSelected] = useState(isoDate(new Date()));
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => { const d = new Date(`${selected}T00:00:00`); d.setDate(d.getDate() - (6 - index)); return isoDate(d); }), [selected]);
  const daily = useQueries({ queries: dates.map((workDate) => orpc.riderGps.own.queryOptions({ input: { workDate } })) });
  const result = daily[6];
  const points = result?.data?.points ?? [];
  const coords = points.map((point) => ({ x: point.longitude, y: point.latitude }));
  const minX = Math.min(...coords.map((p) => p.x), 0), maxX = Math.max(...coords.map((p) => p.x), 1), minY = Math.min(...coords.map((p) => p.y), 0), maxY = Math.max(...coords.map((p) => p.y), 1);
  const line = coords.map((p) => `${20 + ((p.x - minX) / Math.max(0.00001, maxX - minX)) * 280},${20 + (1 - (p.y - minY) / Math.max(0.00001, maxY - minY)) * 180}`).join(" ");
  const shift = (days: number) => { const d = new Date(`${selected}T00:00:00`); d.setDate(d.getDate() + days); setSelected(isoDate(d)); };
  return <Screen><ScreenHeader title="Running chart" subtitle="Daily trip start, end and distance" />
    <Card style={styles.dateCard}><Pressable onPress={() => shift(-1)}><Body color={colors.primary}>‹</Body></Pressable><View style={styles.dateCenter}><Label>SELECTED DATE</Label><Title>{selected}</Title></View><Pressable onPress={() => shift(1)}><Body color={colors.primary}>›</Body></Pressable></Card>
    <Panel><Label>DAILY RUNNING SUMMARY</Label><View style={styles.table}><View style={styles.row}><Small style={styles.dateCol}>DATE</Small><Small>START</Small><Small>END</Small><Small>KM</Small></View>{dates.map((date, index) => { const day = daily[index].data?.day; return <Pressable key={date} onPress={() => setSelected(date)} style={[styles.row, date === selected && { backgroundColor: `${colors.primary}12` }]}><Body style={styles.dateCol}>{date}</Body><Body>{time(day?.clockInAt)}</Body><Body>{time(day?.clockOutAt)}</Body><Body>{((day?.distanceMeters ?? 0) / 1000).toFixed(2)}</Body></Pressable>; })}</View></Panel>
    <Card style={styles.summary}><Label color={colors.primary}>SELECTED DAY</Label><Title>{((result?.data?.day?.distanceMeters ?? 0) / 1000).toFixed(2)} km</Title><Small>{time(result?.data?.day?.clockInAt)} – {time(result?.data?.day?.clockOutAt)} · {result?.data?.day?.acceptedPoints ?? 0} accepted points</Small></Card>
    <Panel style={styles.mapCard}><View style={styles.mapHeader}><Title>Visited route</Title><Pressable onPress={() => void result?.refetch()}><Body color={colors.primary}>Refresh</Body></Pressable></View><View style={[styles.canvas, { backgroundColor: "#E8F1E7" }]}>{line ? <Svg width="100%" height="100%" viewBox="0 0 320 220"><Polyline points={line} fill="none" stroke={colors.primary} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" /><Circle cx={Number(line.split(" ")[0]?.split(",")[0] ?? 20)} cy={Number(line.split(" ")[0]?.split(",")[1] ?? 20)} r="7" fill="#fff" stroke={colors.primary} strokeWidth="4" /><Circle cx={Number(line.split(" ").at(-1)?.split(",")[0] ?? 300)} cy={Number(line.split(" ").at(-1)?.split(",")[1] ?? 200)} r="7" fill="#F59E0B" stroke="#fff" strokeWidth="3" /></Svg> : <Small>No accepted GPS points for this date.</Small>}</View><Small>Routes use accepted GPS points; the server filters inaccurate and unrealistic jumps.</Small></Panel>
  </Screen>;
}
const styles = StyleSheet.create({ dateCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12 }, dateCenter: { alignItems: "center", gap: 2 }, table: { marginTop: 10 }, row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(128,128,128,0.3)" }, dateCol: { width: 92 }, summary: { gap: 5 }, mapCard: { gap: 10 }, mapHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, canvas: { height: 240, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" } });
