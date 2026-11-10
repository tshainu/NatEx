import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Screen, ScreenHeader } from "./screen";
import { Badge } from "./pill";
import { Label, Mono, Small } from "./text";
import { Panel, Empty } from "./card";
import { useColors } from "../../hooks/use-colors";
import { stopView, useOutbox, useRiderRun } from "../../hooks/use-rider-run";
import { apiMessage, client } from "../../lib/api";
import { colomboToday, dateTime, plural } from "../../lib/format";
import { Space, Fonts } from "../../constants/theme";

export type DeliveryOutcome = "delivered" | "failed";

interface OutcomeRow {
  key: string;
  awb: string;
  consigneeName: string;
  timestamp: Date | string | number;
  attemptNo: number;
  runsheetCode: string;
  outcome: DeliveryOutcome;
  isLocal: boolean;
  clientId?: string | null;
  retryCaseId?: string | null;
  retryUntil?: Date | string | null;
  canReattempt?: boolean;
  retryBlockedReason?: string | null;
  reasonLabel?: string;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function shiftDate(value: string, days: number): string {
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function hasOutcome(outcome: DeliveryOutcome, status: string | null, state: string): boolean {
  return outcome === "delivered"
    ? status === "Delivered" || state === "delivered"
    : status === "DeliveryAttempted" || state === "failed";
}

export function DeliveryOutcomeList({ outcome }: { outcome: DeliveryOutcome }) {
  const colors = useColors();
  const [selectedDate, setSelectedDate] = React.useState(colomboToday());
  const isValidDate = validDate(selectedDate);
  const runQuery = useRiderRun();
  const outbox = useOutbox();
  const title = outcome === "delivered" ? "Delivered" : "Failed Attempt";
  const tone = outcome === "delivered" ? "good" : "warn";

  const query = useQuery({
    queryKey: ["rider", "delivery-outcomes", outcome, selectedDate],
    enabled: isValidDate,
    staleTime: 30_000,
    queryFn: async (): Promise<OutcomeRow[]> => {
      if (outcome === "failed") {
        const attempts = await client.delivery.myFailedAttempts({ runDate: selectedDate, limit: 100 });
        return attempts.map((attempt) => ({
          key: `attempt:${attempt.id}`,
          clientId: attempt.clientId,
          awb: attempt.awb,
          consigneeName: attempt.consigneeName,
          timestamp: attempt.timestamp,
          attemptNo: attempt.attemptNo,
          runsheetCode: attempt.runsheetCode,
          outcome: "failed",
          isLocal: false,
          reasonLabel: attempt.reasonLabel,
          retryCaseId: attempt.retryCaseId,
          retryUntil: attempt.retryUntil,
          canReattempt: attempt.canReattempt,
          retryBlockedReason: attempt.retryBlockedReason,
        }));
      }
      const runsheets = await client.delivery.runsheetList({ runDate: selectedDate, limit: 500 });
      const details = await Promise.all(
        runsheets.map((runsheet) => client.delivery.runsheetGet({ runsheetId: runsheet.id })),
      );
      return details.flatMap((detail) =>
        detail.items
          .filter((item) => hasOutcome(outcome, item.status, item.state))
          .map((item) => ({
            key: `${detail.runsheet.id}:${item.id}`,
            awb: item.awb,
            consigneeName: item.consigneeName,
            timestamp: item.settledAt ?? detail.runsheet.dispatchedAt ?? detail.runsheet.createdAt,
            attemptNo: item.attemptNo,
            runsheetCode: detail.runsheet.code,
            outcome,
            isLocal: false,
          })),
      );
    },
  });

  const retryMutation = useMutation({
    mutationFn: (input: { retryCaseId: string; awb: string }) =>
      client.delivery.retryFailedAttempt({ retryCaseId: input.retryCaseId }),
    onSuccess: async (_result, input) => {
      await runQuery.refetch();
      void query.refetch();
      router.replace({ pathname: "/(rider)/stop/[awb]", params: { awb: input.awb } });
    },
  });

  const serverRows = query.data ?? [];
  const serverKeys = new Set(serverRows.map((row) => row.key));
  const serverClientIds = new Set(serverRows.flatMap((row) => row.clientId ? [row.clientId] : []));
  const activeRun = runQuery.data?.run;
  const localRows: OutcomeRow[] = activeRun && activeRun.runsheet.runDate === selectedDate
    ? activeRun.items.flatMap((item) => {
        const { view, entry } = stopView(item, outbox.entries);
        const matches = outcome === "delivered"
          ? view === "delivered" || view === "queued_delivered"
          : view === "failed" || view === "queued_failed";
        const key = `${activeRun.runsheet.id}:${item.id}`;
        if (!matches || serverKeys.has(key) || (entry?.clientOpId && serverClientIds.has(entry.clientOpId))) return [];
        return [{
          key: `local-${key}`,
          awb: item.awb,
          consigneeName: item.consigneeName,
          timestamp: entry?.clientTs ?? item.settledAt ?? activeRun.runsheet.dispatchedAt ?? activeRun.runsheet.createdAt,
          attemptNo: item.attemptNo,
          runsheetCode: activeRun.runsheet.code,
          outcome,
          isLocal: view === "queued_delivered" || view === "queued_failed",
        }];
      })
    : [];
  const rows = [...serverRows, ...localRows].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const pendingAwbs = new Set(outbox.entries.filter((entry) => entry.state === "pending").map((entry) => entry.awb));

  function changeDate(value: string) {
    setSelectedDate(value);
  }

  return (
    <Screen
      refreshing={query.isRefetching || runQuery.isRefetching}
      onRefresh={() => {
        void query.refetch();
        void runQuery.refetch();
      }}
    >
      <ScreenHeader title={title} subtitle="Filter by date · latest records first" />

      <View style={styles.filterBlock}>
        <Label>Date filter</Label>
        <View style={styles.dateRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous day"
            onPress={() => changeDate(shiftDate(isValidDate ? selectedDate : colomboToday(), -1))}
            style={({ pressed }) => [styles.dateArrow, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="chevron-back" size={19} color={colors.foreground} />
          </Pressable>
          <TextInput
            accessibilityLabel="Filter delivery records by date, YYYY-MM-DD"
            value={selectedDate}
            onChangeText={changeDate}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            style={[styles.dateInput, { color: colors.foreground, backgroundColor: colors.card, borderColor: colors.border }]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next day"
            onPress={() => changeDate(shiftDate(isValidDate ? selectedDate : colomboToday(), 1))}
            style={({ pressed }) => [styles.dateArrow, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name="chevron-forward" size={19} color={colors.foreground} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => changeDate(colomboToday())}
            style={({ pressed }) => [styles.todayButton, { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 }]}
          >
            <Label color={colors.primary}>Today</Label>
          </Pressable>
        </View>
        {!isValidDate ? <Small color={colors.statusWarn}>Enter a valid date as YYYY-MM-DD.</Small> : null}
      </View>

      {query.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Label color={colors.statusWarn}>Could not load delivery records</Label>
          <Small>{apiMessage(query.error, "Refresh to try again.")}</Small>
        </Panel>
      ) : null}
      {retryMutation.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Label color={colors.statusWarn}>Could not start re-attempt</Label>
          <Small>{apiMessage(retryMutation.error, "Refresh the failed-attempt list and try again.")}</Small>
        </Panel>
      ) : null}
      {query.isPending && localRows.length === 0 ? <Small>Loading records for {selectedDate}…</Small> : null}
      {isValidDate && query.isSuccess && rows.length === 0 ? (
        <Empty
          title={outcome === "delivered" ? "No deliveries on this date" : "No failed attempts on this date"}
          detail="Choose another date or return to today."
        />
      ) : null}
      {rows.length > 0 ? (
        <View style={styles.tableBlock}>
          <Small>{plural(rows.length, outcome === "delivered" ? "delivery" : "failed attempt")} · {selectedDate}</Small>
          <Small>Swipe horizontally to see all columns.</Small>
          <ScrollView horizontal showsHorizontalScrollIndicator>
            <View style={[styles.table, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <View style={[styles.tableRow, styles.tableHeader, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
                <TableCell width={116} title="DATE / TIME" />
                <TableCell width={150} title="TRACKING NO." />
                <TableCell width={160} title="RECIPIENT" />
                <TableCell width={130} title="ATTEMPT" />
                <TableCell width={196} title="RUN / RESULT" last />
              </View>
              {rows.map((row, index) => (
                <View
                  key={row.key}
                  style={[styles.tableRow, { borderBottomColor: colors.border, backgroundColor: index % 2 ? colors.surface : colors.card }]}
                >
                  <Cell width={116}>{dateTime(row.timestamp)}</Cell>
                  <Mono style={[styles.cell, styles.awbCell]}>{row.awb}</Mono>
                  <Cell width={160}>{row.consigneeName}</Cell>
                  <Cell width={130}>{`Attempt ${Math.max(1, row.attemptNo)}`}</Cell>
                  <View style={[styles.resultCell, { width: 196 }]}>
                    <Badge tone={tone}>{outcome === "delivered" ? "Delivered" : "Failed"}</Badge>
                    {row.isLocal ? <Small color={colors.statusMoving}>Waiting to sync</Small> : <Small>{row.runsheetCode}</Small>}
                    {row.reasonLabel ? <Small numberOfLines={2}>{row.reasonLabel}</Small> : null}
                    {outcome === "failed" && row.canReattempt && row.retryCaseId && !pendingAwbs.has(row.awb) ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Re-attempt delivery ${row.awb}`}
                        disabled={retryMutation.isPending}
                        onPress={() => retryMutation.mutate({ retryCaseId: row.retryCaseId!, awb: row.awb })}
                        style={({ pressed }) => [styles.retryButton, { backgroundColor: colors.accent, opacity: pressed || retryMutation.isPending ? 0.65 : 1 }]}
                      >
                        <Ionicons name="repeat" size={14} color={colors.primary} />
                        <Label color={colors.primary}>Re-Attempt</Label>
                      </Pressable>
                    ) : null}
                    {outcome === "failed" && !row.isLocal && !row.canReattempt && row.retryBlockedReason ? (
                      <Small color={colors.muted} numberOfLines={2}>{row.retryBlockedReason}</Small>
                    ) : null}
                    {outcome === "failed" && row.retryUntil && row.canReattempt ? (
                      <Small color={colors.statusMoving}>Until {dateTime(row.retryUntil)}</Small>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </Screen>
  );
}

function TableCell({ width, title, last = false }: { width: number; title: string; last?: boolean }) {
  return (
    <View style={[styles.headerCell, { width }, !last && styles.cellDivider]}>
      <Label>{title}</Label>
    </View>
  );
}

function Cell({ width, children }: { width: number; children: string }) {
  return <Small style={[styles.cell, { width }]} numberOfLines={2}>{children}</Small>;
}

const styles = StyleSheet.create({
  filterBlock: { gap: Space.unit * 0.5 },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dateArrow: { width: Space.minTouch, height: Space.minTouch, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  dateInput: { flex: 1, minWidth: 100, height: Space.minTouch, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, fontFamily: Fonts.mono, fontSize: 14 },
  todayButton: { minWidth: 66, minHeight: Space.minTouch, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  tableBlock: { gap: Space.unit * 0.5 },
  table: { borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  tableRow: { flexDirection: "row", minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, alignItems: "stretch" },
  tableHeader: { minHeight: 40, alignItems: "center" },
  headerCell: { paddingHorizontal: 9, paddingVertical: 10, justifyContent: "center" },
  cell: { paddingHorizontal: 9, paddingVertical: 10, justifyContent: "center" },
  awbCell: { width: 150, fontSize: 13 },
  cellDivider: { borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: "#7890A0" },
  resultCell: { paddingHorizontal: 9, paddingVertical: 6, justifyContent: "center", gap: 3 },
  retryButton: { minHeight: 36, borderRadius: 10, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
});
