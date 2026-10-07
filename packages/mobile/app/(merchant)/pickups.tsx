import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { apiMessage, client, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { colomboToday, dateTime, humanise } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

const pickupDateDefault = addDays(colomboToday(), 1);

export default function MerchantPickups() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const merchantId = useAuth().session?.user.merchantId;
  const [mode, setMode] = useState<"list" | "request">("list");
  const [pickupDate, setPickupDate] = useState(pickupDateDefault);
  const [window, setWindow] = useState<"morning" | "afternoon">("morning");
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const requests = useQuery({
    ...orpc.collection.pickupRequests.queryOptions({ input: { page: 1, pageSize: 30 } }),
    refetchInterval: 30_000,
  });
  const counts = useQuery({ ...orpc.collection.pickupRequestCounts.queryOptions({ input: {} }), refetchInterval: 30_000 });
  const booked = useQuery({
    ...orpc.parcels.list.queryOptions({ input: { page: 1, pageSize: 100, status: ["Booked"], search: search.trim() || undefined } }),
    enabled: mode === "request",
  });
  const rows = booked.data?.rows ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.awb));

  const toggle = (awb: string) => setSelected((previous) => {
    const next = new Set(previous);
    if (next.has(awb)) next.delete(awb);
    else next.add(awb);
    return next;
  });

  const requestPickup = async () => {
    setError(null);
    if (!merchantId) return setError("This login is not linked to a merchant account.");
    if (selected.size === 0) return setError("Select at least one booked shipment.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) return setError("Enter the date as YYYY-MM-DD.");
    if (pickupDate < colomboToday()) return setError("Choose today or a future date.");
    setSubmitting(true);
    try {
      const result = await client.collection.requestPickup({
        merchantId,
        pickupDate,
        window,
        awbs: [...selected],
        notes: notes.trim() || null,
      });
      setSuccess(`Pickup ${result.code} requested for ${result.parcelCount} parcel${result.parcelCount === 1 ? "" : "s"}.`);
      setSelected(new Set());
      setNotes("");
      setSearch("");
      setMode("list");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.collection.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.parcels.key() }),
      ]);
    } catch (cause) {
      setError(apiMessage(cause, "The pickup could not be requested."));
    } finally {
      setSubmitting(false);
    }
  };

  const cancelPickup = (row: NonNullable<typeof requests.data>["rows"][number]) => {
    Alert.alert("Cancel pickup request?", `${row.code} is still awaiting NatEx. Its parcels can be added to a new request after cancellation.`, [
      { text: "Keep request", style: "cancel" },
      {
        text: "Cancel request",
        style: "destructive",
        onPress: () => {
          setCancellingId(row.id);
          void client.collection.cancelPickupRequest({ id: row.id, reason: "Cancelled by merchant" })
            .then(async () => {
              setSuccess(`Pickup ${row.code} cancelled.`);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: orpc.collection.key() }),
                queryClient.invalidateQueries({ queryKey: orpc.parcels.key() }),
              ]);
            })
            .catch((cause) => setError(apiMessage(cause, "The pickup could not be cancelled.")))
            .finally(() => setCancellingId(null));
        },
      },
    ]);
  };

  const footer = mode === "request" ? (
    <Button title={`Request pickup · ${selected.size} selected`} loading={submitting} disabled={!selected.size} onPress={() => { void requestPickup(); }} />
  ) : null;
  const activeList = useMemo(() => requests.data?.rows ?? [], [requests.data?.rows]);

  return (
    <Screen
      inTabs={mode === "list"}
      footer={footer}
      onRefresh={mode === "list" ? () => { void Promise.all([requests.refetch(), counts.refetch()]); } : undefined}
      refreshing={requests.isRefetching || counts.isRefetching}
    >
      {mode === "list" ? (
        <>
          <View style={styles.headerRow}>
            <View style={styles.flex}>
              <ScreenHeader title="Pickups" subtitle="Choose booked parcels and tell NatEx when to collect them." />
            </View>
            <Pressable accessibilityRole="button" onPress={() => { setError(null); setMode("request"); }} style={styles.addButton}>
              <Ionicons name="add" size={20} color="#FFFFFF" /><Small color="#FFFFFF">New</Small>
            </Pressable>
          </View>
          {success ? <Panel style={{ borderColor: colors.success }}><Body color={colors.success}>{success}</Body></Panel> : null}
          {error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error}</Body></Panel> : null}
          <View style={styles.countRow}>
            <CountTile label="Awaiting NatEx" value={counts.data?.requested ?? "—"} color="#176B2C" />
            <CountTile label="Scheduled" value={counts.data?.scheduled ?? "—"} color="#0B7A53" />
            <CountTile label="Cancelled" value={counts.data?.cancelled ?? "—"} color={colors.mutedForeground} />
          </View>
          {requests.isLoading ? <Panel><Small>Loading pickup requests…</Small></Panel> : activeList.length ? activeList.map((row) => (
            <Card key={row.id}>
              <View style={styles.rowBetween}>
                <View style={styles.flex}>
                  <Mono color="#176B2C">{row.code}</Mono>
                  <Title style={styles.requestTitle}>{row.pickupDate} · {row.window === "morning" ? "Morning (9–12)" : "Afternoon (1–5)"}</Title>
                </View>
                <View style={[styles.statusChip, { backgroundColor: row.status === "scheduled" ? "#E7F5EC" : row.status === "requested" ? "#EDF7F0" : colors.surface }]}>
                  <Small color={row.status === "cancelled" ? colors.mutedForeground : "#176B2C"}>{humanise(row.status)}</Small>
                </View>
              </View>
              <Small>{row.parcelCount} parcel{row.parcelCount === 1 ? "" : "s"} · Requested {dateTime(row.createdAt)}</Small>
              {row.manifestCode ? <Panel><Small>Rider manifest</Small><Mono>{row.manifestCode}</Mono></Panel> : null}
              {row.notes ? <Small>Note: {row.notes}</Small> : null}
              {row.status === "requested" ? (
                <Pressable accessibilityRole="button" disabled={cancellingId === row.id} onPress={() => cancelPickup(row)} style={[styles.cancelButton, { borderColor: colors.border, opacity: cancellingId === row.id ? 0.5 : 1 }]}>
                  <Ionicons name="close-circle-outline" size={18} color={colors.statusWarn} /><Small color={colors.statusWarn}>{cancellingId === row.id ? "Cancelling…" : "Cancel request"}</Small>
                </Pressable>
              ) : null}
            </Card>
          )) : (
            <Empty title="No pickup requests yet" detail="Book shipments first, then select the parcels you want a rider to collect." />
          )}
        </>
      ) : (
        <>
          <View style={styles.headerRow}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back to pickup requests" onPress={() => { setMode("list"); setError(null); }} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="arrow-back" size={19} color={colors.foreground} />
            </Pressable>
            <View style={styles.flex}><ScreenHeader title="Request a pickup" subtitle="Select booked parcels and a preferred collection window." /></View>
          </View>
          {error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error}</Body></Panel> : null}
          <Card>
            <Title>When should we collect?</Title>
            <Input label="Pickup date" value={pickupDate} onChangeText={setPickupDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" hint="Pick a date within the next 14 days." />
            <Label>TIME WINDOW</Label>
            <View style={styles.windowRow}>
              <WindowButton label="Morning · 9–12" selected={window === "morning"} onPress={() => setWindow("morning")} />
              <WindowButton label="Afternoon · 1–5" selected={window === "afternoon"} onPress={() => setWindow("afternoon")} />
            </View>
            <Input label="Note for the rider (optional)" value={notes} onChangeText={setNotes} placeholder="Gate code, contact person, or directions" maxLength={500} />
          </Card>

          <Card>
            <View style={styles.rowBetween}>
              <View style={styles.flex}><Title>Choose shipments</Title><Small>{selected.size} selected</Small></View>
              {rows.length ? <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.awb)))}><Small color="#176B2C">{allSelected ? "Clear shown" : "Select shown"}</Small></Pressable> : null}
            </View>
            <View style={[styles.searchWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
              <Ionicons name="search" size={16} color={colors.mutedForeground} />
              <TextInput value={search} onChangeText={setSearch} placeholder="Search booked AWBs" placeholderTextColor={colors.mutedForeground} autoCapitalize="none" style={[styles.searchInput, { color: colors.foreground }]} />
            </View>
            {booked.isLoading ? <Small>Loading booked shipments…</Small> : rows.length ? rows.map((row) => {
              const checked = selected.has(row.awb);
              return (
                <Pressable key={row.id} accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={() => toggle(row.awb)} style={[styles.parcelSelectRow, { borderColor: checked ? "#176B2C" : colors.border, backgroundColor: checked ? "#EEF8F0" : colors.card }]}>
                  <View style={[styles.checkbox, { borderColor: checked ? "#176B2C" : colors.border, backgroundColor: checked ? "#176B2C" : "transparent" }]}>{checked ? <Ionicons name="checkmark" size={15} color="#FFFFFF" /> : null}</View>
                  <View style={styles.flex}><Mono>{row.awb}</Mono><Body>{row.consigneeName}</Body><Small numberOfLines={1}>{row.destAddress}</Small></View>
                  <Ionicons name="chevron-forward" size={18} color={colors.mutedForeground} />
                </Pressable>
              );
            }) : <Empty title="No booked shipments" detail="Only parcels with Booked status can be added to a pickup request." />}
            {booked.data && booked.data.total > rows.length ? <Small>Showing first {rows.length} of {booked.data.total}. Search to find a parcel not shown.</Small> : null}
          </Card>
          <Small>After NatEx assigns a rider, this request will show as scheduled with the rider’s manifest code.</Small>
        </>
      )}
    </Screen>
  );
}

function CountTile({ label, value, color }: { label: string; value: number | string; color: string }) {
  const colors = useColors();
  return <View style={[styles.countTile, { borderColor: colors.border, backgroundColor: colors.card }]}><Title color={color}>{String(value)}</Title><Small style={styles.countLabel}>{label}</Small></View>;
}

function WindowButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={[styles.windowButton, { borderColor: selected ? "#176B2C" : colors.border, backgroundColor: selected ? "#EEF8F0" : colors.card }]}>
      <Small color={selected ? "#176B2C" : colors.foreground}>{label}</Small>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  addButton: { minHeight: Space.minTouch, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 13, backgroundColor: "#176B2C" },
  backButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  countRow: { flexDirection: "row", gap: 8 },
  countTile: { flex: 1, minHeight: 78, alignItems: "center", justifyContent: "center", borderWidth: 1, borderRadius: 13, padding: 8, gap: 2 },
  countLabel: { textAlign: "center" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  requestTitle: { fontSize: 16, marginTop: 4 },
  statusChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  cancelButton: { minHeight: 46, alignSelf: "flex-start", paddingHorizontal: 12, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  windowRow: { flexDirection: "row", gap: 8 },
  windowButton: { minHeight: 48, flex: 1, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  searchWrap: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10 },
  searchInput: { flex: 1, minHeight: 42, fontSize: 14, fontFamily: "IBMPlexSans_400Regular" },
  parcelSelectRow: { minHeight: Space.minTouch + 15, borderWidth: 1, borderRadius: 13, padding: 11, flexDirection: "row", alignItems: "center", gap: 10 },
  checkbox: { width: 22, height: 22, borderWidth: 1, borderRadius: 6, alignItems: "center", justifyContent: "center" },
});
