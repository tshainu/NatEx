import { Pressable, StyleSheet, View } from "react-native";
import { Link } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiMessage, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, plural } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { MerchantNavigationAction } from "../../components/natex/merchant-navigation-action";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * The rider's day: today's assigned pickups, their scan progress and a separate
 * one-tap route to each merchant's saved GPS location.
 */
export default function RiderTodayScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const today = useQuery(orpc.collection.riderToday.queryOptions({ input: {} }));

  const data = today.data;
  const manifests = data?.manifests ?? [];

  return (
    <Screen inTabs refreshing={today.isRefetching} onRefresh={() => void today.refetch()}>
      <ScreenHeader
        title="Today's pickups"
        subtitle={`${user?.name ?? "Rider"} · ${data ? date(data.pickupDate) : "—"}`}
      />

      {data ? (
        <StatRow>
          <Stat label="Manifests" value={data.totals.manifests} />
          <Stat label="Expected" value={data.totals.expected} />
          <Stat
            label="Still open"
            value={data.totals.pending}
            color={data.totals.pending > 0 ? colors.statusMoving : colors.statusGood}
          />
        </StatRow>
      ) : null}

      {today.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(today.error, "Could not load today's pickups.")}
          </Body>
          <Small>Pull down to try again.</Small>
        </Panel>
      ) : null}

      {today.isPending ? <Small>Loading your manifests…</Small> : null}

      {today.isSuccess && manifests.length === 0 ? (
        <Empty
          title="Nothing assigned today"
          detail="Merchant bookings assigned to you by default and operations-scheduled pickups appear here. Pull down to refresh."
        />
      ) : null}

      <Section>
        {manifests.map((row) => {
          const pending = row.expectedCount - row.scannedCount;
          return (
            <Card key={row.id}>
              <Link href={`/(rider)/manifest/${row.id}`} asChild>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open pickup for ${row.merchantName}`}
                  style={({ pressed }) => [styles.manifestLink, pressed ? styles.pressed : null]}
                >
                  <View style={styles.cardTop}>
                    <View style={styles.flex}>
                      <Title>{row.merchantName}</Title>
                      <Mono color={colors.mutedForeground}>{row.code}</Mono>
                      {row.assignmentSource === "merchant_default" ? (
                        <Badge tone="brand">Auto-assigned</Badge>
                      ) : null}
                    </View>
                    <LifecyclePill status={row.status} />
                  </View>

                  <View style={styles.cardBottom}>
                    <View style={styles.flex}>
                      <Label>Scanned</Label>
                      <Body>
                        {row.scannedCount} of {row.expectedCount}
                      </Body>
                    </View>
                    {pending > 0 ? (
                      <Badge tone="warn">{`${plural(pending, "label")} left`}</Badge>
                    ) : (
                      <Badge tone="good">All scanned</Badge>
                    )}
                    {row.codEnabled ? <Badge tone="brand">COD</Badge> : null}
                  </View>
                </Pressable>
              </Link>

              <MerchantNavigationAction
                merchantName={row.merchantName}
                address={row.merchantAddress}
                latitude={row.merchantLatitude}
                longitude={row.merchantLongitude}
              />
            </Card>
          );
        })}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  manifestLink: { gap: Space.unit },
  pressed: { opacity: 0.75 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: Space.unit,
    marginTop: 2,
  },
});
