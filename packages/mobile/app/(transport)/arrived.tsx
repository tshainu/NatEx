import React from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../lib/api";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Mono, Small, Title } from "../../components/natex/text";
import { plural, since } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

export default function ArrivedTripsScreen() {
  const colors = useColors();
  const board = useQuery(orpc.transport.tripList.queryOptions({ input: {} }));
  const trips = (board.data?.trips ?? []).filter((trip) => trip.status === "arrived");

  return (
    <Screen inTabs refreshing={board.isRefetching} onRefresh={() => void board.refetch()}>
      <ScreenHeader title="Arrived" subtitle="Vehicles that have reached this hub" />
      {board.isError ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>Could not load arrived vehicles.</Body></Panel> : null}
      {board.isSuccess && trips.length === 0 ? <Empty title="No arrived vehicles" detail="Arrived vehicles will appear here after they reach the hub." /> : null}
      <Section>
        {trips.map((trip) => (
          <Card key={trip.id} accessibilityLabel={`Open trip ${trip.code}`} onPress={() => router.push(`/(transport)/trip/${trip.id}`)}>
            <View style={styles.top}>
              <View style={styles.flex}><Title>{trip.code}</Title><Small>{trip.originHubName} → {trip.destHubName}</Small></View>
              <LifecyclePill status={trip.status} />
            </View>
            <Mono>{trip.vehicleRegistration}</Mono>
            <View style={styles.bottom}><Badge>{plural(trip.bagCount, "bag")}</Badge><Badge>{plural(trip.parcelCount, "parcel")}</Badge></View>
            <Small>Arrived {since(trip.arrivedAt ?? trip.createdAt)}</Small>
          </Card>
        ))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  bottom: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit },
});
