import { StyleSheet, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { router } from "expo-router";
import { apiMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, money, since } from "../../lib/format";
import {
  dismiss,
  isRetryableSignaturePODRejection,
  retrySignaturePODRejection,
} from "../../lib/outbox";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Badge, LifecyclePill } from "../../components/natex/pill";
import { SyncStrip } from "../../components/natex/sync-strip";
import { Awb, Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import {
  stopView,
  useOutbox,
  useRiderRun,
  type StopView,
} from "../../hooks/use-rider-run";

/**
 * Today's deliveries: the runsheet, in route order (§10 M3).
 *
 * design.md, "one question per screen" — the question is *which door next*.
 * The next open stop is pinned first and is the only card with the primary
 * colour; done stops sink to the bottom. Everything here opens offline from
 * the phone's last copy of the run (§7).
 */

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
  const open = stops.filter((s) => s.view === "todo");
  const problems = stops.filter((s) => s.view === "problem");
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
  const done = stops.filter((s) => s.view !== "todo" && s.view !== "problem");
  const dispatched = run?.runsheet.status === "dispatched";

  // Cash in the rider's hand right now: what the server has, plus what this
  // phone has collected but not yet synced. Integer cents throughout (§1).
  const queuedCod = box.entries
    .filter((e) => e.state === "pending" && e.kind === "delivery.deliver")
    .reduce((n, e) => n + (Number(e.payload.codCollectedCents) || 0), 0);
  const collected = (run?.cash.collectedCents ?? 0) + queuedCod;
  const expected = run?.cash.expectedCents ?? 0;

  // Outbox problems for parcels no longer on this run still need to be seen.
  const onRun = new Set(stops.map((s) => s.stop.awb));
  const orphanConflicts = box.entries.filter((e) => e.state === "conflict" && !onRun.has(e.awb));
  const orphanRejected = box.entries.filter((e) => e.state === "rejected" && !onRun.has(e.awb));

  return (
    <Screen
      inTabs
      refreshing={runQuery.isRefetching}
      onRefresh={() => void runQuery.refetch()}
    >
      <ScreenHeader
        title="Today's deliveries"
        subtitle={
          run
            ? `${run.runsheet.code} · ${run.hubName ?? "Hub"} · ${date(run.runsheet.runDate)}`
            : (user?.name ?? "Rider")
        }
        right={run ? <LifecyclePill status={run.runsheet.status} /> : undefined}
      />

      <SyncStrip />

      {runQuery.data?.fromCache ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <Body color={colors.statusMoving}>Offline — showing the run saved on this phone</Body>
          <Small>
            Saved {since(runQuery.data.cachedAt)}. You can keep delivering; records sync when the
            signal is back.
          </Small>
        </Panel>
      ) : null}

      {runQuery.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>
            {apiMessage(runQuery.error, "Could not load your run, and none is saved on this phone.")}
          </Body>
          <Small>Pull down to try again.</Small>
        </Panel>
      ) : null}

      {runQuery.isPending ? <Small>Loading your run…</Small> : null}

      {runQuery.isSuccess && !run ? (
        <Empty
          title="No delivery run assigned yet"
          detail="The hub builds and dispatches your run in the morning. Pull down to refresh."
        />
      ) : null}

      {run ? (
        <StatRow>
          <Stat label="Stops left" value={open.length} color={open.length > 0 ? colors.statusMoving : colors.statusGood} />
          <Stat label="Done" value={done.length} />
          <Stat label="COD in hand" value={money(collected)} />
        </StatRow>
      ) : null}

      {run && expected > 0 ? (
        <Small>
          {money(expected - collected)} still to collect of {money(expected)} expected on this run.
        </Small>
      ) : null}

      {run && !dispatched ? (
        <Panel style={{ borderColor: colors.statusMoving }}>
          <Title>Not dispatched yet</Title>
          <Small>
            The hub is still loading this run. Stops open for delivery once it is dispatched and
            the parcels are out for delivery with you.
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
                This delivery was rejected before the signature-only backend update. Retry now with the saved signature.
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
              accessibilityLabel={`Open ${stop.awb}`}
              onPress={() => router.push(`/(rider)/stop/${stop.awb}`)}
              style={{ borderColor: colors.statusWarn }}
            >
              <Awb>{stop.awb}</Awb>
              <Small color={colors.statusWarn}>{entry?.error ?? "The server reported a conflict."}</Small>
            </Card>
          ))}
          {orphanConflicts.map((entry) => (
            <Card key={entry.clientOpId} style={{ borderColor: colors.statusWarn }}>
              <Awb>{entry.awb}</Awb>
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
                <View style={styles.row}>
                  <View style={[styles.seq, { backgroundColor: first ? colors.primary : colors.surface }]}>
                    <Mono color={first ? colors.primaryForeground : colors.foreground}>{String(stop.seq)}</Mono>
                  </View>
                  <View style={styles.flex}>
                    <Title>{stop.consigneeName}</Title>
                    <Mono color={colors.mutedForeground}>{stop.awb}</Mono>
                  </View>
                  {leg ? <Small>{leg}</Small> : null}
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
        <Empty title="Every stop is done" detail="Head back to the hub to hand in cash and returns." />
      ) : null}

      {done.length > 0 ? (
        <Section>
          <Label>Done · {done.length}</Label>
          {done.map(({ stop, view }) => {
            const copy = VIEW_COPY[view];
            return (
              <Card
                key={stop.id}
                accessibilityLabel={`Open ${stop.awb}`}
                onPress={() => router.push(`/(rider)/stop/${stop.awb}`)}
              >
                <View style={styles.row}>
                  <Mono style={styles.flex}>{stop.awb}</Mono>
                  <Badge tone={copy.tone}>{copy.text}</Badge>
                </View>
                <Small>{stop.consigneeName}</Small>
              </Card>
            );
          })}
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.5 },
  seq: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: Space.unit, marginTop: 2 },
});
