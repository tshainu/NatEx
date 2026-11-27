import React from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Card } from "../../components/natex/card";
import { Body, Small, Title } from "../../components/natex/text";
import { useColors } from "../../hooks/use-colors";

const ACTIONS = [
  ["Bags", "Create, scan, and seal bags", "bag-handle-outline", "/(rider)/ops-bags"],
  ["Transport", "Load and depart vehicles; review arrivals", "bus-outline", "/(rider)/ops-transport"],
  ["Inbound", "Receive arrived bags into this hub", "download-outline", "/(rider)/ops-inbound"],
] as const;

export default function OpsScreen() {
  const colors = useColors();
  return (
    <Screen inTabs>
      <ScreenHeader title="Ops" subtitle="Hub operations" />
      {ACTIONS.map(([title, detail, icon, href]) => (
        <Card key={title} onPress={() => router.push(href)} accessibilityLabel={`Open ${title}`}>
          <Ionicons name={icon} size={28} color={colors.primary} />
          <Title>{title}</Title>
          <Body>{detail}</Body>
          <Small color={colors.mutedForeground}>Open workspace</Small>
        </Card>
      ))}
    </Screen>
  );
}
