import React from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiMessage, orpc } from "../../lib/api";
import { grams, plural, since } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * What is on its way here.
 *
 * §7: the receiving hub can see a bag before it physically arrives, because a
 * bag that left Colombo three hours ago and is not on the dock yet is the
 * single most useful thing a Kandy clerk can know. The list is therefore
 * "expected", not "arrived" — tapping a row opens the receipt screen, and it is
 * the physical scan there, not the arrival of the truck, that moves custody.
 */
export default function InboundScreen() {
  const colors = useColors();
  const inbound = useQuery(orpc.transport.inbound.queryOptions({ input: {} }));
  const counts = useQuery(orpc.transport.counts.queryOptions({ input: {} }));

  const rows = inbound.data ?? [];
  const parcels = rows.reduce((total, row) => total + (row.itemCount ?? 0), 0);

  return (
    <Screen
      inTabs
      refreshing={inbound.isRefetching}
      onRefresh={() => {
        void inbound.refetch();
        void counts.refetch();
      }}
    >
      <ScreenHeader
        title="Inbound"
        subtitle="Bags in transit to this hub. Receive each one against its manifest."
      />

      {inbound.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(inbound.error, "Could not load the inbound queue.")}
          </Body>
        </Panel>
      ) : null}

      <StatRow>
        <Stat label="Bags due" value={rows.length} />
        <Stat label="Parcels" value={parcels} />
        <Stat
          label="Awaiting reconcile"
          value={counts.data?.bagsAwaitingReconciliation ?? "—"}
          color={
            (counts.data?.bagsAwaitingReconciliation ?? 0) > 0 ? colors.statusWarn : undefined
          }
        />
      </StatRow>

      <Section>
        <Label>Expected · {rows.length}</Label>
        {inbound.isPending ? (
          <Empty title="Loading…" />
        ) : rows.length === 0 ? (
          <Empty
            title="Nothing inbound"
            detail="No sealed bag is currently in transit to this hub."
          />
        ) : (
          rows.map((row) => (
            <Card
              key={row.id}
              onPress={() => router.push(`/(transport)/receive/${row.id}`)}
              accessibilityLabel={`Receive bag ${row.code}`}
            >
              <View style={styles.row}>
                <Mono style={styles.flex}>{row.code}</Mono>
                <LifecyclePill status={row.status} />
              </View>
              <Small>
                {row.originHubName} → {row.destHubName}
              </Small>
              <View style={styles.row}>
                <Badge>{plural(row.itemCount ?? 0, "parcel")}</Badge>
                {row.weightGrams ? <Badge>{grams(row.weightGrams)}</Badge> : null}
                {row.tripCode ? <Badge>{row.tripCode}</Badge> : <Badge tone="warn">No trip</Badge>}
              </View>
              <View style={styles.row}>
                <Label>Seal</Label>
                <Mono style={styles.flex}>{row.sealNumber ?? "—"}</Mono>
              </View>
              <Small>
                Sealed {since(row.sealedAt)}
                {row.tripStatus ? ` · trip ${row.tripStatus.replace("_", " ")}` : ""}
              </Small>
            </Card>
          ))
        )}
      </Section>

      <Panel>
        <Small>
          A bag stays on this list until someone here receives it. Receiving needs the
          seal in front of you and every label scanned — the screen compares both against
          what the origin hub sealed and records any difference as an exception.
        </Small>
      </Panel>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
});
