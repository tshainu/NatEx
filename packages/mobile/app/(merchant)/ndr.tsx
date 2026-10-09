import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { AddressFields, EMPTY_ADDRESS, formatAddress, isCompleteAddress, type AddressParts } from "../../components/natex/address-fields";
import { Screen } from "../../components/natex/screen";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { apiMessage, client, orpc } from "../../lib/api";
import { colomboToday, dateTime, humanise } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

type Instruction = "reattempt" | "address_change" | "hold" | "rto";

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

export default function MerchantNdr() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState<Instruction>("reattempt");
  const [reattemptDate, setReattemptDate] = useState(() => addDays(colomboToday(), 1));
  const [newAddress, setNewAddress] = useState<AddressParts>(EMPTY_ADDRESS);
  const [newPhone, setNewPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const queue = useQuery({
    ...orpc.ndr.page.queryOptions({ input: { page: 1, pageSize: 50, state: ["open", "instructed", "reattempt_scheduled"] } }),
    refetchInterval: 30_000,
  });
  const counts = useQuery({ ...orpc.ndr.counts.queryOptions({ input: {} }), refetchInterval: 30_000 });
  const selected = queue.data?.rows.find((row) => row.id === selectedId) ?? null;

  const sendInstruction = async () => {
    if (!selected) return;
    setError(null);
    if ((instruction === "reattempt" || instruction === "address_change") && !/^\d{4}-\d{2}-\d{2}$/.test(reattemptDate)) {
      setError("Enter the reattempt date as YYYY-MM-DD.");
      return;
    }
    const addressHasContent = Boolean(newAddress.line1.trim() || newAddress.line2.trim() || newAddress.district || newAddress.province);
    if (instruction === "address_change" && !addressHasContent && !newPhone.trim()) {
      setError("Enter a corrected address, phone number, or both.");
      return;
    }
    if (instruction === "address_change" && addressHasContent && !isCompleteAddress(newAddress)) {
      setError("Complete the corrected address with line 1, district and province, or clear it to update only the phone.");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Parameters<typeof client.ndr.instruct>[0] = {
        ndrId: selected.id,
        instruction,
        notes: notes.trim() || null,
        reattemptDate: instruction === "reattempt" || instruction === "address_change" ? reattemptDate : null,
        newAddress: instruction === "address_change" && addressHasContent ? formatAddress(newAddress) : null,
        newPhone: instruction === "address_change" ? newPhone.trim() || null : null,
      };
      await client.ndr.instruct(payload);
      setSuccess(`${selected.awb}: ${instruction === "rto" ? "return requested" : "instruction sent"}.`);
      setSelectedId(null);
      setNotes("");
      setNewAddress(EMPTY_ADDRESS);
      setNewPhone("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.ndr.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.parcels.key() }),
      ]);
    } catch (cause) {
      setError(apiMessage(cause, "Your instruction could not be sent. Review the message and try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmInstruction = () => {
    if (instruction !== "rto") {
      void sendInstruction();
      return;
    }
    Alert.alert(
      "Request return to merchant?",
      `This starts the return process for ${selected?.awb}. The parcel will no longer be delivered to the consignee.`,
      [
        { text: "Review", style: "cancel" },
        { text: "Request return", style: "destructive", onPress: () => { void sendInstruction(); } },
      ],
    );
  };

  return (
    <Screen onRefresh={() => { void Promise.all([queue.refetch(), counts.refetch()]); }} refreshing={queue.isRefetching || counts.isRefetching}>
      <View style={styles.headerRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="arrow-back" size={19} color={colors.foreground} />
        </Pressable>
        <View style={styles.flex}><Label>MERCHANT ACTIONS</Label><Title>Failed deliveries</Title></View>
      </View>
      <Small>Choose what NatEx should do next for a delivery that could not be completed.</Small>

      <View style={styles.summaryRow}>
        <SummaryTile label="Need your answer" value={(counts.data?.open ?? 0) + (counts.data?.instructed ?? 0) + (counts.data?.reattemptScheduled ?? 0)} color="#176B2C" />
        <SummaryTile label="Overdue" value={counts.data?.overdue ?? 0} color={counts.data?.overdue ? colors.statusWarn : colors.success} />
      </View>

      {success ? <Panel style={{ borderColor: colors.success }}><Body color={colors.success}>{success}</Body></Panel> : null}
      {error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error}</Body></Panel> : null}
      {queue.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(queue.error, "NDRs could not be loaded.")}</Body></Panel> : null}

      {queue.isLoading ? <Panel><Small>Loading failed deliveries…</Small></Panel> : queue.data?.rows.length ? (
        queue.data.rows.map((row) => (
          <Card key={row.id} style={row.overdue ? { borderColor: colors.statusWarn } : undefined}>
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/(merchant)/shipment/[awb]", params: { awb: row.awb } })}>
              <View style={styles.rowBetween}>
                <View style={styles.flex}><Mono color="#176B2C">{row.awb}</Mono><Title style={styles.reason}>{row.lastReasonLabel}</Title></View>
                <View style={[styles.slaPill, { backgroundColor: row.overdue ? "#FFF1F0" : colors.surface }]}><Small color={row.overdue ? colors.statusWarn : colors.mutedForeground}>{row.overdue ? "OVERDUE" : row.hoursLeft === null ? humanise(row.state) : `${row.hoursLeft}h left`}</Small></View>
              </View>
              <Small>{row.attempts} delivery attempt{row.attempts === 1 ? "" : "s"} · Raised {dateTime(row.raisedAt)}</Small>
              {row.instructionNotes ? <Small>Last instruction: {row.instructionNotes}</Small> : null}
            </Pressable>
            <Button title={selectedId === row.id ? "Close instructions" : "Choose instruction"} variant="secondary" onPress={() => { setSelectedId(selectedId === row.id ? null : row.id); setError(null); }} />
            {selectedId === row.id ? (
              <View style={[styles.instructionPanel, { borderTopColor: colors.border }]}>
                <Label>WHAT SHOULD NATEX DO?</Label>
                <View style={styles.actionGrid}>
                  <InstructionButton label="Try again" icon="refresh-outline" selected={instruction === "reattempt"} onPress={() => setInstruction("reattempt")} />
                  <InstructionButton label="Fix address" icon="location-outline" selected={instruction === "address_change"} onPress={() => setInstruction("address_change")} />
                  <InstructionButton label="Hold" icon="pause-circle-outline" selected={instruction === "hold"} onPress={() => setInstruction("hold")} />
                  <InstructionButton label="Return to me" icon="return-down-back-outline" selected={instruction === "rto"} onPress={() => setInstruction("rto")} danger />
                </View>

                {instruction === "reattempt" || instruction === "address_change" ? (
                  <Input label="Preferred reattempt date" value={reattemptDate} onChangeText={setReattemptDate} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" hint="NatEx will confirm scheduling." />
                ) : null}
                {instruction === "address_change" ? (
                  <>
                    <AddressFields value={newAddress} onChange={setNewAddress} />
                    <Input label="Corrected phone number" value={newPhone} onChangeText={setNewPhone} keyboardType="phone-pad" placeholder="New phone (optional if address is corrected)" />
                  </>
                ) : null}
                <Input label={instruction === "rto" ? "Reason for return" : "Note for NatEx (optional)"} value={notes} onChangeText={setNotes} maxLength={600} placeholder={instruction === "rto" ? "Why should this parcel be returned?" : "Add context for the operations team"} />
                {instruction === "rto" ? <Small color={colors.statusWarn}>Requesting a return stops delivery to the consignee and starts return handling.</Small> : null}
                <Button title={instruction === "rto" ? "Confirm return request" : "Send instruction"} loading={submitting} onPress={confirmInstruction} />
              </View>
            ) : null}
          </Card>
        ))
      ) : (
        <Empty title="No failed deliveries need an answer" detail="When NatEx records a failed delivery, it will appear here with the response deadline." />
      )}
      {queue.data && queue.data.total > queue.data.rows.length ? <Small>Showing the first {queue.data.rows.length} of {queue.data.total} open reports.</Small> : null}
    </Screen>
  );
}

function SummaryTile({ label, value, color }: { label: string; value: number; color: string }) {
  const colors = useColors();
  return <View style={[styles.summaryTile, { borderColor: colors.border, backgroundColor: colors.card }]}><Title color={color}>{value}</Title><Small>{label}</Small></View>;
}

function InstructionButton({ label, icon, selected, onPress, danger = false }: { label: string; icon: keyof typeof Ionicons.glyphMap; selected: boolean; onPress: () => void; danger?: boolean }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress} style={[styles.instructionButton, { backgroundColor: selected ? (danger ? "#FFF1F0" : "#EEF8F0") : colors.card, borderColor: selected ? (danger ? colors.statusWarn : "#176B2C") : colors.border }]}>
      <Ionicons name={icon} size={18} color={danger ? colors.statusWarn : selected ? "#176B2C" : colors.mutedForeground} />
      <Small color={danger && selected ? colors.statusWarn : selected ? "#176B2C" : colors.foreground}>{label}</Small>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  backButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  summaryRow: { flexDirection: "row", gap: 9 },
  summaryTile: { flex: 1, minHeight: 70, borderWidth: 1, borderRadius: 12, padding: 11, gap: 2 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  reason: { fontSize: 16, marginTop: 3 },
  slaPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 999 },
  instructionPanel: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12, gap: 10 },
  actionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  instructionButton: { minHeight: Space.minTouch, borderWidth: 1, borderRadius: 12, flexGrow: 1, flexBasis: "45%", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 8 },
});
