import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { apiMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, money, plural, since } from "../../lib/format";
import {
  dismiss,
  isRetryableSignaturePODRejection,
  retrySignaturePODRejection,
} from "../../lib/outbox";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { SyncStrip } from "../../components/natex/sync-strip";
import { Awb, Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { stopView, useOutbox, useRiderRun } from "../../hooks/use-rider-run";
import type { StopView } from "../../lib/rider-run-reconcile";

const VIEW_COPY: Record<StopView, { text: string; tone: "muted" | "brand" | "good" | "warn" | "bad" }> = {
  todo: { text: "To deliver", tone: "brand" },
  queued_delivered: { text: "Delivered · not synced", tone: "good" },
  queued_failed: { text: "Failed · not synced", tone: "warn" },
  delivered: { text: "Delivered", tone: "good" },
  failed: { text: "Attempted", tone: "warn" },
  removed: { text: "Removed by hub", tone: "muted" },
  problem: { text: "Needs ops", tone: "bad" },
};

function km(metres: number | null | undefined): string | null {
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
}

export default function RiderDeliveriesScreen() {
  const colors = useColors();
  const { user } = useAuth();
  const runQuery = useRiderRun();
  const box = useOutbox();
  const signatureRetry = useMutation({ mutationFn: retrySignaturePODRejection });
  const run = runQuery.data?.run ?? null;

  const stops = (run?.items ?? []).map((stop) => ({ stop, ...stopView(stop, box.entries) }));
  const open = stops.filter((item) => item.view === "todo");
  const problems = stops.filter((item) => item.view === "problem");
  const retryableProblems = problems.flatMap(({ stop, entry }) => {
    if (
      !entry ||
      !isRetryableSignaturePODRejection(entry) ||
      stop.status !== "OutForDelivery" ||
      stop.state !== "pending"
    ) {
      return [];
    }
    return [{ stop, entry }];
  });
  const retryableIds = new Set(retryableProblems.map(({ entry }) => entry.clientOpId));
  const needsOpsProblems = problems.filter(({ entry }) => entry?.state === "conflict");
  const rejectedProblems = problems.filter(
    ({ entry }) => entry?.state === "rejected" && !retryableIds.has(entry.clientOpId),
  );
  const done = stops.filter((item) => item.view !== "todo" && item.view !== "problem");
  const dispatched = run?.runsheet.status === "dispatched";
  const progress = run?.items.length ? Math.round((done.length / run.items.length) * 100) : 0;
  const serverDeliveredAwbs = new Set(
    stops.filter(({ stop }) => stop.status === "Delivered").map(({ stop }) => stop.awb),
  );
  const alreadyDeliveredForReview = stops.filter(
    ({ stop, entry }) =>
      stop.status === "Delivered" && (entry?.state === "conflict" || entry?.state === "rejected"),
  );

  // Cash in the rider's hand: server totals plus offline delivery records waiting to sync.
  const queuedCod = box.entries
    .filter((entry) => entry.state === "pending" && entry.kind === "delivery.deliver")
    .reduce((total, entry) => total + (Number(entry.payload.codCollectedCents) || 0), 0);
  const collected = (run?.cash.collectedCents ?? 0) + queuedCod;
  const expected = run?.cash.expectedCents ?? 0;

  // Outbox problems for parcels no longer on this run still need to be visible.
  const onRun = new Set(stops.map((item) => item.stop.awb));
  const orphanConflicts = box.entries.filter((entry) => entry.state === "conflict" && !onRun.has(entry.awb));
  const orphanRejected = box.entries.filter((entry) => entry.state === "rejected" && !onRun.has(entry.awb));

  return (
    <Screen inTabs refreshing={runQuery.isRefetching} onRefresh={() => void runQuery.refetch()}>
      <ScreenHeader
        title="Run"
        subtitle={run ? `${user?.name ?? "Rider"} · ${run.runsheet.code}` : (user?.name ?? "Rider")}
        right={run ? <LifecyclePill status={run.runsheet.status} /> : undefined}
      />

      <SyncStrip resolvedDeliveredAwbs={serverDeliveredAwbs} />

      {runQuery.data?.fromCache ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <View style={styles.noticeHeading}>
            <Ionicons name="cloud-offline-outline" size={20} color={colors.statusMoving} />
            <Title color={colors.statusMoving}>Offline route copy</Title>
          </View>
          <Small>
            Saved {since(runQuery.data.cachedAt)}. You can continue working; queued records sync when the signal returns.
          </Small>
        </Panel>
      ) : null}

      {runQuery.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Title color={colors.statusWarn}>Could not load the route</Title>
          <Small>{apiMessage(runQuery.error, "No live or saved run is available on this phone.")}</Small>
          <Small>Pull down to try again.</Small>
        </Panel>
      ) : null}

      {runQuery.isPending ? <Small>Loading your run…</Small> : null}

      {runQuery.isSuccess && !run ? (
        <Empty title="No run assigned" detail="The hub builds and dispatches your route. Pull down to refresh." />
      ) : null}

      {run ? (
        <Panel style={styles.overview}>
          <View style={styles.overviewTop}>
            <View style={styles.flex}>
              <Label color={colors.primary}>TODAY'S ROUTE</Label>
              <Title>{run.runsheet.code}</Title>
              <Small>{run.hubName ?? "Hub"} · {date(run.runsheet.runDate)}</Small>
            </View>
            <View style={styles.leftCount}>
              <Mono color={open.length ? colors.primary : colors.statusGood}>{String(open.length)}</Mono>
              <Label>LEFT</Label>
            </View>
          </View>

          <View style={styles.progressMeta}>
            <Body>{done.length} of {run.items.length} stops complete</Body>
            <Mono color={colors.mutedForeground}>{progress}%</Mono>
          </View>
          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: colors.primary }]} />
          </View>

          <View style={[styles.cashRow, { borderTopColor: colors.border }]}>
            <View style={styles.cashMetric}>
              <Label>COD in hand</Label>
              <Mono>{money(collected)}</Mono>
            </View>
            <View style={styles.cashMetric}>
              <Label>Expected</Label>
              <Mono>{money(expected)}</Mono>
            </View>
          </View>
          {expected > 0 && collected < expected ? (
            <Small>{money(expected - collected)} still to collect of {money(expected)} expected on this run.</Small>
          ) : null}
        </Panel>
      ) : null}

      {run && !dispatched ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <Title>Waiting for dispatch</Title>
          <Small>The hub is still loading this run. Stops become actionable once the run is dispatched and parcels are Out for Delivery.</Small>
        </Panel>
      ) : null}

      {alreadyDeliveredForReview.length > 0 ? (
        <Panel style={{ borderColor: colors.statusGood }}>
          <View style={styles.noticeHeading}>
            <Ionicons name="checkmark-circle-outline" size={20} color={colors.statusGood} />
            <Title color={colors.statusGood}>Already delivered · read-only</Title>
          </View>
          <Small>
            The server confirms {plural(alreadyDeliveredForReview.length, "parcel")} as delivered. A later duplicate update was refused and kept for review; do not try to deliver these parcels again.
          </Small>
        </Panel>
      ) : null}

      {retryableProblems.length > 0 ? (
        <Section>
          <Label color={colors.statusMoving}>Retry signature POD · {retryableProblems.length}</Label>
          {retryableProblems.map(({ stop, entry }) => (
            <Card key={stop.id} style={{ borderColor: colors.statusMoving }}>
              <Awb>{stop.awb}</Awb>
              <Small color={colors.statusMoving}>
                This delivery was rejected before the signature-only backend update. Retry with the saved signature.
              </Small>
              <Button
                title="Retry with saved signature"
                variant="secondary"
                loading={signatureRetry.isPending}
                onPress={() => signatureRetry.mutate(entry.clientOpId)}
              />
            </Card>
          ))}
          {signatureRetry.isError ? (
            <Panel style={{ borderColor: colors.statusWarn }}>
              <Small color={colors.statusWarn}>Could not retry this saved delivery. Refresh the run and ask the hub if it remains here.</Small>
            </Panel>
          ) : null}
        </Section>
      ) : null}

      {needsOpsProblems.length > 0 || orphanConflicts.length > 0 ? (
        <Section>
          <Label color={colors.statusWarn}>Needs ops · {needsOpsProblems.length + orphanConflicts.length}</Label>
          {needsOpsProblems.map(({ stop, entry }) => (
            <Card
              key={stop.id}
              accessibilityLabel={`Review ${stop.awb} with operations`}
              onPress={() => router.push(`/(rider)/stop/${stop.awb}`)}
              style={{ borderColor: colors.statusWarn }}
            >
              <View style={styles.row}>
                <Mono style={styles.flex}>{stop.awb}</Mono>
                <Badge tone="warn">Review</Badge>
              </View>
              <Small color={colors.statusWarn}>{entry?.error ?? "The server reported a conflict."}</Small>
            </Card>
          ))}
          {orphanConflicts.map((entry) => (
            <Card key={entry.clientOpId} style={{ borderColor: colors.statusWarn }}>
              <View style={styles.row}>
                <Mono style={styles.flex}>{entry.awb}</Mono>
                <Badge tone="warn">Review</Badge>
              </View>
              <Small color={colors.statusWarn}>{entry.error ?? "The server reported a conflict."}</Small>
              <Button title="Dismiss — ops has it" variant="ghost" onPress={() => void dismiss(entry.clientOpId)} />
            </Card>
          ))}
        </Section>
      ) : null}

      {rejectedProblems.length > 0 || orphanRejected.length > 0 ? (
        <Section>
          <Label color={colors.statusMoving}>Rejected · review</Label>
          {rejectedProblems.map(({ stop, entry }) => (
            <Card key={stop.id} style={{ borderColor: colors.statusMoving }}>
              <Awb>{stop.awb}</Awb>
              <Small color={colors.statusMoving}>{entry?.error ?? "The server rejected this record. Ask the hub to review it."}</Small>
            </Card>
          ))}
          {orphanRejected.map((entry) => (
            <Card key={entry.clientOpId} style={{ borderColor: colors.statusMoving }}>
              <Awb>{entry.awb}</Awb>
              <Small color={colors.statusMoving}>{entry.error ?? "The server rejected this record."}</Small>
              <Button title="Dismiss rejected record" variant="ghost" onPress={() => void dismiss(entry.clientOpId)} />
            </Card>
          ))}
        </Section>
      ) : null}

      {open.length > 0 ? (
        <Section>
          <Label>Next stops · {open.length}</Label>
          {open.map(({ stop, view }, index) => {
            const copy = VIEW_COPY[view];
            const leg = km(stop.legMetres);
            const first = index === 0 && dispatched;
            return (
              <Card
                key={stop.id}
                accessibilityLabel={`Open stop ${stop.seq} for ${stop.consigneeName}`}
                onPress={() => router.push(`/(rider)/stop/${stop.awb}`)}
                style={first ? { borderColor: colors.primary, borderWidth: 2 } : undefined}
              >
                <View style={styles.stopHeader}>
                  <View style={[styles.sequence, { backgroundColor: first ? colors.primary : colors.surface }]}>
                    <Mono color={first ? colors.primaryForeground : colors.foreground}>{String(stop.seq)}</Mono>
                  </View>
                  <View style={styles.flex}>
                    <Label color={first ? colors.primary : colors.mutedForeground}>{first ? "NEXT STOP" : `STOP ${stop.seq}`}</Label>
                    <Title>{stop.consigneeName}</Title>
                    <Mono color={colors.mutedForeground}>{stop.awb}</Mono>
                  </View>
                  {leg ? <Small>{leg}</Small> : <Ionicons name="chevron-forward" size={20} color={colors.mutedForeground} />}
                </View>
                <Small>{stop.destAddress}</Small>
                <View style={styles.badges}>
                  <Badge tone={copy.tone}>{copy.text}</Badge>
                  {stop.codAmountCents > 0 ? <Badge tone="brand">{`COD ${money(stop.codAmountCents)}`}</Badge> : null}
                  {stop.podPolicy ? <Badge>{`${stop.podPolicy} POD`}</Badge> : null}
                  {stop.attemptNo > 0 ? <Badge tone="warn">{`Attempt ${stop.attemptNo + 1} of 3`}</Badge> : null}
                </View>
              </Card>
            );
          })}
        </Section>
      ) : run && run.items.length > 0 && problems.length === 0 ? (
        <Empty title="Route complete" detail="Every stop is accounted for. Head back to the hub to hand in cash and returns." />
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  overview: { gap: Space.unit * 1.5 },
  overviewTop: { flexDirection: "row", alignItems: "center", gap: Space.unit * 2 },
  leftCount: {
    minWidth: 62,
    minHeight: 62,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(16,185,129,0.12)",
    gap: 2,
  },
  progressMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  progressTrack: { height: 8, borderRadius: Space.radiusPill, overflow: "hidden" },
  progressFill: { height: "100%", borderRadius: Space.radiusPill },
  cashRow: { flexDirection: "row", gap: Space.unit * 2, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: Space.unit * 1.5, marginTop: Space.unit / 2 },
  cashMetric: { flex: 1, gap: 4 },
  noticeHeading: { flexDirection: "row", alignItems: "center", gap: Space.unit },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  stopHeader: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  sequence: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit, marginTop: 2 },
});
