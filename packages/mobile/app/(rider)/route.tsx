import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Card, Panel } from "../../components/natex/card";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";

function isoDate(value: Date) { return value.toISOString().slice(0, 10); }
export default function RiderRouteScreen() {
  const colors = useColors(); const [selected, setSelected] = useState(isoDate(new Date()));
  const result = useQuery(orpc.riderGps.own.queryOptions({ input: { workDate: selected } }));
  const points = result.data?.points ?? []; const coords = points.map((point) => ({ x: point.longitude, y: point.latitude }));
  const minX = Math.min(...coords.map((p) => p.x), 0), maxX = Math.max(...coords.map((p) => p.x), 1), minY = Math.min(...coords.map((p) => p.y), 0), maxY = Math.max(...coords.map((p) => p.y), 1);
  const line = coords.map((p) => `${20 + ((p.x - minX) / Math.max(0.00001, maxX - minX)) * 280},${20 + (1 - (p.y - minY) / Math.max(0.00001, maxY - minY)) * 180}`).join(" ");
  const shift = (days: number) => { const d = new Date(`${selected}T00:00:00`); d.setDate(d.getDate() + days); setSelected(isoDate(d)); };
  return <Screen><ScreenHeader title="Running chart" subtitle="Date-wise GPS route history" /><Card style={styles.dateCard}><Pressable onPress={() => shift(-1)}><Body color={colors.primary}>‹</Body></Pressable><View style={styles.dateCenter}><Label>SELECTED DATE</Label><Title>{selected}</Title></View><Pressable onPress={() => shift(1)}><Body color={colors.primary}>›</Body></Pressable></Card><Card style={styles.summary}><Label color={colors.primary}>KM RUN</Label><Title>{((result.data?.day?.distanceMeters ?? 0) / 1000).toFixed(2)} km</Title><Small>{result.data?.day?.acceptedPoints ?? 0} accepted points</Small></Card><Panel style={styles.mapCard}><View style={styles.mapHeader}><Title>Visited route</Title><Pressable onPress={() => void result.refetch()}><Body color={colors.primary}>Refresh</Body></Pressable></View><View style={[styles.canvas, { backgroundColor: "#E8F1E7" }]}>{line ? <Svg width="100%" height="100%" viewBox="0 0 320 220"><Polyline points={line} fill="none" stroke={colors.primary} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" /><Circle cx={Number(line.split(" ")[0]?.split(",")[0] ?? 20)} cy={Number(line.split(" ")[0]?.split(",")[1] ?? 20)} r="7" fill="#fff" stroke={colors.primary} strokeWidth="4" /><Circle cx={Number(line.split(" ").at(-1)?.split(",")[0] ?? 300)} cy={Number(line.split(" ").at(-1)?.split(",")[1] ?? 200)} r="7" fill="#F59E0B" stroke="#fff" strokeWidth="3" /></Svg> : <Small>No accepted GPS points for this date.</Small>}</View><Small>Routes use accepted riderGps.own points only; accuracy and unrealistic jumps are filtered by the server.</Small></Panel><Panel><Label>KM RUN TABLE</Label>{points.length ? <View style={styles.table}><View style={styles.row}><Small>DATE</Small><Small>POINTS</Small><Small>KM</Small></View><View style={styles.row}><Body>{selected}</Body><Body>{points.length}</Body><Body>{((result.data?.day?.distanceMeters ?? 0) / 1000).toFixed(2)}</Body></View></View> : <Small>No route record for {selected}.</Small>}</Panel></Screen>;
}
const styles = StyleSheet.create({ dateCard: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 12 }, dateCenter: { alignItems: "center", gap: 2 }, summary: { gap: 5 }, mapCard: { gap: 10 }, mapHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, canvas: { height: 240, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" }, table: { gap: 8 }, row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(128,128,128,0.3)" } });
