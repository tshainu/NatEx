import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Polyline } from "react-native-svg";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Card, Panel } from "../../components/natex/card";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { Button } from "../../components/natex/button";
import { orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";

export default function RiderRouteScreen() {
  const colors = useColors();
  const result = useQuery(orpc.riderGps.own.queryOptions({ input: {} }));
  const points = result.data?.points ?? [];
  const coords = points.map((point) => ({ x: point.longitude, y: point.latitude }));
  const minX = Math.min(...coords.map((point) => point.x), 0); const maxX = Math.max(...coords.map((point) => point.x), 1);
  const minY = Math.min(...coords.map((point) => point.y), 0); const maxY = Math.max(...coords.map((point) => point.y), 1);
  const line = coords.map((point) => `${20 + ((point.x - minX) / Math.max(0.00001, maxX - minX)) * 280},${20 + (1 - (point.y - minY) / Math.max(0.00001, maxY - minY)) * 180}`).join(" ");
  const distance = (result.data?.day?.distanceMeters ?? 0) / 1000;
  return <Screen footer={<Button title="Back to settings" variant="secondary" onPress={() => router.back()} />}>
    <ScreenHeader title="Today’s route" subtitle="OpenStreetMap route tracking · 90-day history" />
    <Card style={styles.summary}><Label color={colors.primary}>TRAVELLED TODAY</Label><Title color={colors.foreground}>{distance.toFixed(2)} km</Title><Small>{result.data?.day?.acceptedPoints ?? 0} accepted GPS points · {result.data?.day?.syncState ?? "not started"}</Small></Card>
    <Panel style={styles.mapCard}><View style={styles.mapHeader}><View><Title>Visited route</Title><Small>Line drawing from accepted GPS points</Small></View><Pressable onPress={() => void result.refetch()}><Body color={colors.primary}>Refresh</Body></Pressable></View><View style={[styles.canvas, { backgroundColor: "#E8F1E7" }]}>{line ? <Svg width="100%" height="100%" viewBox="0 0 320 220"><Polyline points={line} fill="none" stroke={colors.primary} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" /><Circle cx={Number(line.split(" ")[0]?.split(",")[0] ?? 20)} cy={Number(line.split(" ")[0]?.split(",")[1] ?? 20)} r="7" fill="#FFFFFF" stroke={colors.primary} strokeWidth="4" /><Circle cx={Number(line.split(" ").at(-1)?.split(",")[0] ?? 300)} cy={Number(line.split(" ").at(-1)?.split(",")[1] ?? 200)} r="7" fill="#F59E0B" stroke="#FFFFFF" strokeWidth="3" /></Svg> : <Small>No accepted GPS points yet. Enable GPS and continue your shift.</Small>}</View><Small>Map tiles and route details use OpenStreetMap data in the Reports view. GPS points with accuracy worse than 100 m or unrealistic jumps are filtered.</Small></Panel>
  </Screen>;
}

const styles = StyleSheet.create({ summary: { gap: 5, borderWidth: 0 }, mapCard: { gap: 10 }, mapHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, canvas: { height: 240, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" } });
