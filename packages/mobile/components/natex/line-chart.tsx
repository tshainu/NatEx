import React from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { Small } from "./text";
import { useColors } from "../../hooks/use-colors";

export function LineChart({ series, empty = "No data available yet." }: { series: { label: string; values: number[]; color: string }[]; empty?: string }) {
  const colors = useColors();
  const values = series.flatMap((item) => item.values);
  if (!values.length || values.every((value) => value === 0)) return <View style={styles.empty}><Small>{empty}</Small></View>;
  const max = Math.max(...values, 1); const width = 320; const height = 130;
  return <View style={styles.wrap}><Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}><Polyline points={`0,${height - 8} ${width},${height - 8}`} stroke={colors.border} strokeWidth="1" />{series.map((item) => <Polyline key={item.label} points={item.values.map((value, index) => `${(index / Math.max(1, item.values.length - 1)) * (width - 12) + 6},${height - 12 - (value / max) * (height - 24)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />)}</Svg><View style={styles.legend}>{series.map((item) => <View key={item.label} style={styles.legendItem}><View style={[styles.dot, { backgroundColor: item.color }]} /><Small>{item.label}</Small></View>)}</View></View>;
}
const styles = StyleSheet.create({ wrap: { gap: 6 }, empty: { minHeight: 100, alignItems: "center", justifyContent: "center" }, legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 }, legendItem: { flexDirection: "row", alignItems: "center", gap: 5 }, dot: { width: 8, height: 8, borderRadius: 4 } });
