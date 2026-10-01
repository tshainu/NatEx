import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiMessage, client, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { grams, plural, since } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * Outbound bags at this hub.
 *
 * The status filter defaults to the two states that still need a human — open
 * bags to fill and sealed bags to load — because a clerk opening this tab is
 * asking "what is still on my floor", not "show me everything ever bagged".
 */
const FILTERS = [
  { key: "live", label: "On the floor", status: ["open", "sealed"] as const },
  { key: "moving", label: "In transit", status: ["in_transit"] as const },
  { key: "done", label: "Closed", status: ["received", "reconciled", "cancelled"] as const },
] as const;

export default function TransportBagsScreen() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["key"]>("live");
  const [creating, setCreating] = React.useState(false);
  const [destHubId, setDestHubId] = React.useState<string | null>(null);

  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const bags = useQuery(
    orpc.transport.bagList.queryOptions({ input: { status: [...active.status] } }),
  );
  const counts = useQuery(orpc.transport.counts.queryOptions({ input: {} }));
  const branches = useQuery(orpc.identity.listBranches.queryOptions({ input: {} }));

  const create = useMutation({
    mutationFn: (dest: string) => client.transport.bagCreate({ destHubId: dest }),
    onSuccess: (bag) => {
      void queryClient.invalidateQueries({ queryKey: orpc.transport.key() });
      setCreating(false);
      setDestHubId(null);
      router.push(`/(transport)/bag/${bag.id}`);
    },
  });

  // A bag can only go to another hub, never back to the one it is standing in.
  const destinations = (branches.data ?? []).filter((b) => b.id !== user?.branchId);
  const rows = bags.data ?? [];

  const footer = creating ? (
    <>
      <Button
        title="Create bag"
        loading={create.isPending}
        disabled={!destHubId}
        hint={!destHubId ? "Choose a destination hub" : undefined}
        onPress={() => destHubId && create.mutate(destHubId)}
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
    <Button title="New bag" onPress={() => setCreating(true)} />
  );

  return (
    <Screen
      inTabs
      footer={footer}
      refreshing={bags.isRefetching}
      onRefresh={() => {
        void bags.refetch();
        void counts.refetch();
      }}
    >
      <ScreenHeader
        title="Bags"
        subtitle={user?.branchName ? `${user.branchName} hub` : undefined}
      />

      {counts.data ? (
        <StatRow>
          <Stat label="Open" value={counts.data.bagsOpen} />
          <Stat
            label="Sealed"
            value={counts.data.bagsSealed}
            color={counts.data.bagsSealed > 0 ? colors.statusMoving : undefined}
          />
          <Stat label="In transit" value={counts.data.bagsInTransit} />
          <Stat
            label="Awaiting reconciliation"
            value={counts.data.bagsAwaitingReconciliation}
            color={
              counts.data.bagsAwaitingReconciliation > 0 ? colors.statusMoving : undefined
            }
          />
          <Stat
            label="Open exceptions"
            value={counts.data.openExceptions}
            color={counts.data.openExceptions > 0 ? colors.statusWarn : colors.statusGood}
          />
        </StatRow>
      ) : null}

      {creating ? (
        <Card>
          <Label>Destination hub</Label>
          <Small>
            Everything scanned into this bag must be going to the hub you pick here.
          </Small>
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
              {apiMessage(create.error, "The bag was not created.")}
            </Small>
          ) : null}
        </Card>
      ) : null}

      <View style={styles.chips}>
        {FILTERS.map((option) => {
          const selected = option.key === filter;
          return (
            <Pressable
              key={option.key}
              onPress={() => setFilter(option.key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.chip,
                {
                  borderColor: selected ? colors.primary : colors.border,
                  backgroundColor: selected ? colors.accent : "transparent",
                },
              ]}
            >
              <Body color={selected ? colors.primary : colors.mutedForeground}>
                {option.label}
              </Body>
            </Pressable>
          );
        })}
      </View>

      {bags.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>{apiMessage(bags.error, "Could not load bags.")}</Body>
        </Panel>
      ) : null}

      {bags.isSuccess && rows.length === 0 ? (
        <Empty
          title="No bags here"
          detail={
            filter === "live"
              ? "Create a bag to start consolidating parcels for a destination hub."
              : "Nothing in this state right now."
          }
        />
      ) : null}

      <Section>
        {rows.map((row) => (
          <Card
            key={row.id}
            accessibilityLabel={`Open bag ${row.code}`}
            onPress={() => router.push(`/(transport)/bag/${row.id}`)}
          >
            <View style={styles.cardTop}>
              <View style={styles.flex}>
                <Title>{row.code}</Title>
                <Small>
                  {row.originHubName} → {row.destHubName}
                </Small>
              </View>
              <LifecyclePill status={row.status} />
            </View>
            <View style={styles.cardBottom}>
              <Badge>{`${plural(row.itemCount, "parcel")}`}</Badge>
              {row.weightGrams ? <Badge>{grams(row.weightGrams)}</Badge> : null}
              {row.sealNumber ? (
                <Mono color={colors.primary}>{row.sealNumber}</Mono>
              ) : (
                <Badge tone="warn">Unsealed</Badge>
              )}
            </View>
            <Small>Created {since(row.createdAt)}</Small>
          </Card>
        ))}
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
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: Space.unit,
  },
});
