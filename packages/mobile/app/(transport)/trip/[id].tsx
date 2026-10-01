import React from "react";
import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../../lib/api";
import { dateTime, plural } from "../../../lib/format";
import { Screen, ScreenHeader, Section } from "../../../components/natex/screen";
import { Button } from "../../../components/natex/button";
import { Card, Empty, Field, Panel } from "../../../components/natex/card";
import { Input } from "../../../components/natex/input";
import { Badge, LifecyclePill } from "../../../components/natex/pill";
import { Body, Label, Mono, Small } from "../../../components/natex/text";
import { Space } from "../../../constants/theme";
import { useColors } from "../../../hooks/use-colors";

/**
 * One trip: load sealed bags, depart, arrive.
 *
 * §6 refuses departure while any loaded bag is unsealed, and this screen says
 * so before the button is pressed rather than after — the unsealed count is
 * computed from the loaded bags and becomes the button's hint. Arrival moves the
 * vehicle only; the parcels move when the destination hub receipts each bag,
 * which is why arriving sends the clerk to Inbound rather than declaring
 * anything delivered.
 */
export default function TripScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = String(id);

  const [seal, setSeal] = React.useState("");
  const [departing, setDeparting] = React.useState(false);

  const detail = useQuery(orpc.transport.tripGet.queryOptions({ input: { tripId } }));
  // Only sealed bags heading somewhere can be loaded; the list is the hub's
  // sealed stock, minus whatever is already on a trip.
  const sealed = useQuery(
    orpc.transport.bagList.queryOptions({ input: { status: ["sealed"] } }),
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: orpc.transport.key() });
  }

  const load = useMutation({
    mutationFn: (bagId: string) => client.transport.tripLoad({ tripId, bagId }),
    onSuccess: invalidate,
  });

  const depart = useMutation({
    mutationFn: () => client.transport.tripDepart({ tripId, seal: seal.trim() }),
    onSuccess: () => {
      invalidate();
      setDeparting(false);
      setSeal("");
    },
  });

  const arrive = useMutation({
    mutationFn: () => client.transport.tripArrive({ tripId }),
    onSuccess: invalidate,
  });

  const data = detail.data;
  const trip = data?.trip;
  const bags = data?.bags ?? [];
  const unsealed = bags.filter((b) => !b.sealNumber);
  const loadable = (sealed.data ?? []).filter((b) => b.tripId === null);
  const canLoad = trip?.status === "planned" || trip?.status === "loading";

  let footer: React.ReactNode = null;
  if (departing) {
    footer = (
      <>
        <Button
          title="Depart"
          loading={depart.isPending}
          disabled={seal.trim().length < 3}
          onPress={() => depart.mutate()}
        />
        <Button title="Cancel" variant="ghost" onPress={() => setDeparting(false)} />
      </>
    );
  } else if (canLoad) {
    footer = (
      <Button
        title="Depart trip"
        disabled={bags.length === 0 || unsealed.length > 0}
        hint={
          bags.length === 0
            ? "Load at least one sealed bag"
            : unsealed.length > 0
              ? `${plural(unsealed.length, "loaded bag")} still unsealed`
              : undefined
        }
        onPress={() => setDeparting(true)}
      />
    );
  } else if (trip?.status === "departed") {
    footer = (
      <Button title="Mark arrived" loading={arrive.isPending} onPress={() => arrive.mutate()} />
    );
  } else if (trip?.status === "arrived") {
    footer = (
      <Button
        title="Go to inbound receipts"
        variant="secondary"
        onPress={() => router.push("/(transport)/inbound")}
      />
    );
  } else {
    footer = <Button title="Back to linehaul" variant="secondary" onPress={() => router.back()} />;
  }

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={detail.isRefetching}
      onRefresh={() => {
        void detail.refetch();
        void sealed.refetch();
      }}
    >
      <ScreenHeader
        title={trip?.code ?? "Trip"}
        subtitle={data ? `${data.originHubName} → ${data.destHubName}` : undefined}
        right={trip ? <LifecyclePill status={trip.status} /> : undefined}
      />

      {detail.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(detail.error, "Could not load this trip.")}
          </Body>
        </Panel>
      ) : null}

      <Panel>
        <View style={styles.row}>
          <Field label="Vehicle" value={trip?.vehicleRegistration} mono />
          <Field label="Parcels" value={String(data?.parcelCount ?? 0)} />
        </View>
        {trip?.route ? <Field label="Route" value={trip.route} /> : null}
        {trip?.seal ? <Field label="Vehicle seal" value={trip.seal} mono /> : null}
        {trip?.departedAt ? <Field label="Departed" value={dateTime(trip.departedAt)} /> : null}
        {trip?.arrivedAt ? <Field label="Arrived" value={dateTime(trip.arrivedAt)} /> : null}
      </Panel>

      {departing ? (
        <Card>
          <Label>Vehicle seal number</Label>
          <Small>
            Departure moves every parcel aboard from Bagged to In transit. The vehicle
            seal is recorded against the trip, separately from each bag's own seal.
          </Small>
          <Input code value={seal} onChangeText={setSeal} placeholder="VEH-000000" autoFocus />
          {depart.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(depart.error, "The trip did not depart.")}
            </Small>
          ) : null}
        </Card>
      ) : null}

      {arrive.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(arrive.error, "Arrival was not recorded.")}
          </Body>
        </Panel>
      ) : null}

      <Section>
        <Label>Loaded · {bags.length}</Label>
        {bags.length === 0 ? (
          <Empty title="Nothing loaded" detail="Load a sealed bag from the list below." />
        ) : (
          bags.map((bag) => (
            <Card
              key={bag.id}
              accessibilityLabel={`Open bag ${bag.code}`}
              onPress={() => router.push(`/(transport)/bag/${bag.id}`)}
            >
              <View style={styles.row}>
                <Mono style={styles.flex}>{bag.code}</Mono>
                <LifecyclePill status={bag.status} />
              </View>
              <View style={styles.metaRow}>
                <Badge>{`${plural(bag.itemCount, "parcel")}`}</Badge>
                {bag.sealNumber ? (
                  <Mono color={colors.primary}>{bag.sealNumber}</Mono>
                ) : (
                  <Badge tone="warn">Unsealed — blocks departure</Badge>
                )}
              </View>
              <Small>To {bag.destHubName}</Small>
            </Card>
          ))
        )}
      </Section>

      {canLoad ? (
        <Section>
          <Label>Sealed and waiting · {loadable.length}</Label>
          {loadable.length === 0 ? (
            <Empty
              title="No sealed bags waiting"
              detail="Seal a bag on the Bags tab before loading it."
            />
          ) : (
            loadable.map((bag) => (
              <Card key={bag.id}>
                <View style={styles.row}>
                  <Mono style={styles.flex}>{bag.code}</Mono>
                  <Button
                    title="Load"
                    variant="secondary"
                    loading={load.isPending && load.variables === bag.id}
                    onPress={() => load.mutate(bag.id)}
                  />
                </View>
                <Small>
                  {bag.destHubName} · {plural(bag.itemCount, "parcel")} ·{" "}
                  {bag.sealNumber}
                </Small>
              </Card>
            ))
          )}
          {load.isError ? (
            <Small color={colors.statusWarn}>
              {apiMessage(load.error, "That bag was not loaded.")}
            </Small>
          ) : null}
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: Space.unit },
});
