import { StyleSheet, View } from "react-native";
import { Link } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { apiMessage, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, plural } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

/**
 * The rider's day, as one screen: every manifest assigned to them today, with
 * how many labels are still unscanned on each.
 *
 * design.md, "one question per screen" — the question here is *where do I go
 * next*, so each card leads straight to the scan screen for that merchant and
 * the pending count is the biggest thing on it.
 */
export default function RiderTodayScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const today = useQuery(orpc.collection.riderToday.queryOptions({ input: {} }));

  const data = today.data;
  const manifests = data?.manifests ?? [];

  return (
    <Screen
      inTabs
      refreshing={today.isRefetching}
      onRefresh={() => void today.refetch()}
    >
      <ScreenHeader
        title="Pickups"
        subtitle={`${user?.name ?? "Rider"} · ${data ? date(data.pickupDate) : "—"}`}
      />

      {data ? (
        <Panel style={styles.overview}>
          <View style={styles.summaryText}>
            <Label color={colors.primary}>TODAY'S COLLECTION</Label>
            <Title>{plural(data.totals.manifests, "pickup stop")}</Title>
            <Small>{data.totals.expected} labels declared · {date(data.pickupDate)}</Small>
          </View>
          <View style={[styles.pendingCount, { backgroundColor: `${colors.primary}1F` }]}>
            <Mono color={data.totals.pending > 0 ? colors.primary : colors.statusGood}>
              {String(data.totals.pending)}
            </Mono>
            <Label>TO SCAN</Label>
          </View>
        </Panel>
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
        {manifests.map((row, index) => {
          const pending = row.expectedCount - row.scannedCount;
          return (
            <Link key={row.id} href={`/(rider)/manifest/${row.id}`} asChild>
              <Card
                accessibilityLabel={`Open pickup for ${row.merchantName}`}
                onPress={() => {}}
                style={index === 0 ? { borderColor: colors.primary, borderWidth: 2 } : undefined}
              >
                <View style={styles.cardTop}>
                  <View style={styles.flex}>
                    <Label color={index === 0 ? colors.primary : colors.mutedForeground}>
                      {index === 0 ? "NEXT PICKUP" : `PICKUP ${index + 1}`}
                    </Label>
                    <Title>{row.merchantName}</Title>
                    <Mono color={colors.mutedForeground}>{row.code}</Mono>
                    {row.assignmentSource === "merchant_default" ? (
                      <Badge tone="brand">Auto-assigned</Badge>
                    ) : null}
                  </View>
                  <LifecyclePill status={row.status} />
                </View>

                <Small>{row.merchantAddress}</Small>

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
              </Card>
            </Link>
          );
        })}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overview: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: Space.unit * 2 },
  summaryText: { flex: 1, gap: 4 },
  pendingCount: { minWidth: 64, minHeight: 64, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 2 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: Space.unit },
  cardBottom: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: Space.unit,
    marginTop: 2,
  },
});
