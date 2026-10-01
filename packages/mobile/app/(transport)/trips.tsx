import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { plural, since } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * The linehaul board: every trip from or to this hub.
 *
 * `bagsReceived` against `bagCount` is the column that matters after arrival —
 * a trip is not finished when the vehicle lands, it is finished when the
 * destination hub has receipted every bag on it (§7), and this is where an
 * unreceipted bag stops being invisible.
 */
export default function TransportTripsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const [creating, setCreating] = React.useState(false);
  const [vehicle, setVehicle] = React.useState("");
  const [route, setRoute] = React.useState("");
  const [destHubId, setDestHubId] = React.useState<string | null>(null);

  const board = useQuery(orpc.transport.tripList.queryOptions({ input: {} }));
  const branches = useQuery(orpc.identity.listBranches.queryOptions({ input: {} }));

  const create = useMutation({
    mutationFn: () =>
      client.transport.tripCreate({
        vehicleRegistration: vehicle.trim(),
        destHubId: destHubId!,
        route: route.trim() || null,
      }),
    onSuccess: (trip) => {
      void queryClient.invalidateQueries({ queryKey: orpc.transport.key() });
      setCreating(false);
      setVehicle("");
      setRoute("");
      setDestHubId(null);
      router.push(`/(transport)/trip/${trip.id}`);
    },
  });

  const destinations = (branches.data ?? []).filter((b) => b.id !== user?.branchId);
  const trips = board.data?.trips ?? [];

  const footer = creating ? (
    <>
      <Button
        title="Create trip"
        loading={create.isPending}
        disabled={vehicle.trim().length < 3 || !destHubId}
        hint={!destHubId ? "Choose a destination hub" : undefined}
        onPress={() => create.mutate()}
      />
      <Button
        title="Cancel"
        variant="ghost"
        disabled={create.isPending}
        onPress={() => {
          setCreating(false);
          create.reset();
        }}
      />
    </>
  ) : (
    <Button title="New trip" onPress={() => setCreating(true)} />
  );

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={board.isRefetching}
      onRefresh={() => void board.refetch()}
    >
      <ScreenHeader title="Linehaul" subtitle="Trips from and to this hub" />

      {board.data ? (
        <StatRow>
          <Stat label="Planned" value={board.data.counts.planned} />
          <Stat
            label="In flight"
            value={board.data.counts.inFlight}
            color={board.data.counts.inFlight > 0 ? colors.statusMoving : undefined}
          />
          <Stat label="Arrived" value={board.data.counts.arrived} />
        </StatRow>
      ) : null}

      {creating ? (
        <Card>
          <Input
            label="Vehicle registration"
            code
            value={vehicle}
            onChangeText={setVehicle}
            placeholder="WP-CAB-1234"
            autoFocus
          />
          <Input
            label="Route (optional)"
            value={route}
            onChangeText={setRoute}
            placeholder="Colombo — Kandy via Kegalle"
          />
          <Label>Destination hub</Label>
          <View style={styles.chips}>
            {destinations.map((branch) => {
              const selected = destHubId === branch.id;
              return (
                <Pressable
                  key={branch.id}
                  onPress={() => setDestHubId(branch.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Destination ${branch.name}`}
                  style={[
                    styles.chip,
                    {
                      borderColor: selected ? colors.primary : colors.border,
                      backgroundColor: selected ? colors.primary : "transparent",
                    },
                  ]}
                >
                  <Body color={selected ? colors.primaryForeground : colors.foreground}>
                    {branch.name}
                  </Body>
                </Pressable>
              );
            })}
          </View>
          {create.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(create.error, "The trip was not created.")}
            </Small>
          ) : null}
        </Card>
      ) : null}

      {board.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(board.error, "Could not load the linehaul board.")}
          </Body>
        </Panel>
      ) : null}

      {board.isSuccess && trips.length === 0 ? (
        <Empty
          title="No trips"
          detail="Create a trip, load your sealed bags onto it, then depart."
        />
      ) : null}

      <Section>
        {trips.map((trip) => {
          const outstanding = trip.bagCount - trip.bagsReceived;
          return (
            <Card
              key={trip.id}
              accessibilityLabel={`Open trip ${trip.code}`}
              onPress={() => router.push(`/(transport)/trip/${trip.id}`)}
            >
              <View style={styles.cardTop}>
                <View style={styles.flex}>
                  <Title>{trip.code}</Title>
                  <Small>
                    {trip.originHubName} → {trip.destHubName}
                  </Small>
                </View>
                <LifecyclePill status={trip.status} />
              </View>
              <Mono>{trip.vehicleRegistration}</Mono>
              <View style={styles.cardBottom}>
                <Badge>{`${plural(trip.bagCount, "bag")}`}</Badge>
                <Badge>{`${plural(trip.parcelCount, "parcel")}`}</Badge>
                {trip.status === "arrived" ? (
                  outstanding > 0 ? (
                    <Badge tone="warn">{`${plural(outstanding, "bag")} unreceipted`}</Badge>
                  ) : (
                    <Badge tone="good">All bags receipted</Badge>
                  )
                ) : null}
              </View>
              <Small>
                {trip.departedAt
                  ? `Departed ${since(trip.departedAt)}`
                  : `Created ${since(trip.createdAt)}`}
              </Small>
            </Card>
          );
        })}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit },
  chip: {
    minHeight: Space.minTouch,
    justifyContent: "center",
    paddingHorizontal: Space.card,
    borderWidth: 1,
    borderRadius: Space.radius,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: Space.unit },
});
