import { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Screen } from "../../components/natex/screen";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";
import { apiMessage, client, orpc } from "../../lib/api";
import { dateTime, humanise, money, parseRupeesToCents } from "../../lib/format";

type DisputeType = Parameters<typeof client.disputes.open>[0]["type"];
type DisputeRow = Awaited<ReturnType<typeof client.disputes.list>>["rows"][number];

const PARCEL_CASES = new Set<DisputeType>(["cod_shortfall", "damage", "loss"]);
const PAID_CLAIMS = new Set<DisputeType>(["cod_shortfall", "damage", "loss", "billing"]);

const TYPE_HINTS: Record<DisputeType, string> = {
  cod_shortfall: "Report COD collected but not fully credited. The AWB and claimed amount are required.",
  damage: "Report goods damaged while in NatEx custody. The AWB and claimed amount are required.",
  loss: "Report a parcel lost while in NatEx custody. The AWB and claimed amount are required.",
  billing: "Question an invoice charge. Enter the amount being disputed; an AWB is optional.",
  sla: "Raise a service-level complaint. Use Rs. 0 when no money is claimed; an AWB is optional.",
  other: "Raise another issue for NatEx Finance. Use Rs. 0 when no money is claimed; an AWB is optional.",
};

export default function MerchantDisputes() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<DisputeType>("cod_shortfall");
  const [awb, setAwb] = useState("");
  const [amountText, setAmountText] = useState("0");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const meta = useQuery({
    ...orpc.disputes.meta.queryOptions({ input: {} }),
    staleTime: 10 * 60_000,
  });
  const cases = useQuery({
    ...orpc.disputes.list.queryOptions({ input: { limit: 50, offset: 0 } }),
    refetchInterval: 30_000,
  });

  const claimAmountCents = parseRupeesToCents(amountText);
  const needsAwb = PARCEL_CASES.has(type);
  const amountError = amountText.trim() && claimAmountCents === null
    ? "Enter a valid amount in rupees, with no more than two decimal places."
    : claimAmountCents !== null && PAID_CLAIMS.has(type) && claimAmountCents <= 0
      ? "Enter an amount greater than Rs. 0 for this case."
      : null;
  const descriptionError = description.trim().length > 0 && description.trim().length < 10
    ? "Please describe what happened in at least 10 characters."
    : null;
  const canSubmit =
    claimAmountCents !== null &&
    !amountError &&
    description.trim().length >= 10 &&
    (!needsAwb || Boolean(awb.trim()));

  const refresh = () => {
    void Promise.all([meta.refetch(), cases.refetch()]);
  };

  const resetForm = () => {
    setType("cod_shortfall");
    setAwb("");
    setAmountText("0");
    setDescription("");
    setError(null);
  };

  const submit = async () => {
    if (!canSubmit || claimAmountCents === null) return;
    setError(null);
    setSubmitting(true);
    try {
      const opened = await client.disputes.open({
        awb: awb.trim().toUpperCase() || undefined,
        type,
        claimAmountCents,
        description: description.trim(),
      });
      setSuccess(`${opened.code} is open with NatEx Finance.`);
      setShowForm(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: orpc.disputes.key() });
    } catch (cause) {
      setError(apiMessage(cause, "The dispute could not be opened. Check the details and try again."));
    } finally {
      setSubmitting(false);
    }
  };

  const confirmSubmit = () => {
    if (!canSubmit) return;
    const payoutHoldApplies = PARCEL_CASES.has(type) && (claimAmountCents ?? 0) > 0;
    Alert.alert(
      "Open this dispute?",
      payoutHoldApplies
        ? "NatEx Finance will review the case. A temporary hold will be placed on the related merchant payout while a COD shortfall, loss or damage claim is investigated."
        : "NatEx Finance will review the case and respond within the dispute service window.",
      [
        { text: "Review", style: "cancel" },
        { text: "Open dispute", onPress: () => { void submit(); } },
      ],
    );
  };

  return (
    <Screen onRefresh={refresh} refreshing={cases.isRefetching || meta.isRefetching}>
      <View style={styles.headerRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Go back"
          onPress={() => router.back()}
          style={[styles.backButton, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Ionicons name="arrow-back" size={19} color={colors.foreground} />
        </Pressable>
        <View style={styles.flex}>
          <Label>MERCHANT SUPPORT</Label>
          <Title>Disputes & claims</Title>
        </View>
      </View>
      <Small>Open a case with NatEx Finance and follow its progress here.</Small>

      {success ? (
        <Panel style={{ borderColor: colors.success }}>
          <Body color={colors.success}>{success}</Body>
        </Panel>
      ) : null}
      {cases.isError ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Body color={colors.statusWarn}>{apiMessage(cases.error, "Disputes could not be loaded.")}</Body>
        </Panel>
      ) : null}

      <Button
        title={showForm ? "Cancel opening a dispute" : "Open a dispute"}
        variant={showForm ? "secondary" : "primary"}
        icon={<Ionicons name={showForm ? "close-outline" : "chatbox-ellipses-outline"} size={20} color={showForm ? colors.foreground : colors.primaryForeground} />}
        onPress={() => {
          setShowForm((open) => !open);
          setError(null);
          setSuccess(null);
        }}
      />

      {showForm ? (
        <Card>
          <Title>Tell us what happened</Title>
          <Small>Choose a case type. NatEx Finance will review your submission.</Small>

          <View style={styles.fieldGroup}>
            <Label>PROBLEM TYPE</Label>
            {meta.isLoading ? <Small>Loading case types…</Small> : null}
            {meta.isError ? <Small color={colors.statusWarn}>Case types could not be loaded. Pull down to retry.</Small> : null}
            <View style={styles.typeGrid}>
              {(meta.data?.types ?? []).map((item) => {
                const selected = type === item.type;
                return (
                  <Pressable
                    key={item.type}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setType(item.type)}
                    style={[
                      styles.typeOption,
                      {
                        backgroundColor: selected ? "#E7F5EC" : colors.surface,
                        borderColor: selected ? "#176B2C" : colors.border,
                      },
                    ]}
                  >
                    <Small color={selected ? "#176B2C" : colors.foreground}>{item.label}</Small>
                  </Pressable>
                );
              })}
            </View>
            <Small>{TYPE_HINTS[type]}</Small>
          </View>

          <Input
            label="AWB / Tracking number"
            value={awb}
            onChangeText={(value) => setAwb(value.toUpperCase())}
            code
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={40}
            placeholder="NX…"
            hint={needsAwb ? "Required for COD shortfall, damage and loss." : "Optional for this type of case."}
          />
          <Input
            label="Amount claimed (Rs.)"
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            maxLength={12}
            placeholder="0.00"
            error={amountError}
            hint="Enter Rs. 0 for a complaint with no monetary claim. Finance checks claim limits against parcel/COD records."
          />
          <Input
            label="What happened"
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            maxLength={2000}
            placeholder="Include the relevant details and what you need NatEx to review."
            error={descriptionError}
            hint={`${description.trim().length}/2000 characters · at least 10 required`}
          />
          {needsAwb && !awb.trim() ? <Small color={colors.statusWarn}>Enter the AWB for this case.</Small> : null}
          {error ? (
            <Panel style={{ borderColor: colors.statusWarn }}>
              <Body color={colors.statusWarn}>{error}</Body>
            </Panel>
          ) : null}
          <Button
            title="Submit to NatEx Finance"
            loading={submitting}
            disabled={!canSubmit || meta.isLoading || meta.isError}
            onPress={confirmSubmit}
          />
        </Card>
      ) : null}

      <View style={styles.listHeader}>
        <Title>Your cases</Title>
        {cases.data ? <Small>{cases.data.total} total</Small> : null}
      </View>
      {cases.isLoading ? (
        <Panel><Small>Loading your disputes…</Small></Panel>
      ) : cases.data?.rows.length ? (
        <View style={styles.caseList}>
          {cases.data.rows.map((row) => (
            <DisputeCard key={row.id} row={row} types={meta.data?.types ?? []} />
          ))}
          {cases.data.total > cases.data.rows.length ? (
            <Small>Showing the latest {cases.data.rows.length} cases.</Small>
          ) : null}
        </View>
      ) : !cases.isError ? (
        <Empty title="No disputes yet" detail="When you open a case, its status and claim details will appear here." />
      ) : null}
    </Screen>
  );
}

function DisputeCard({
  row,
  types,
}: {
  row: DisputeRow;
  types: Array<{ type: DisputeType; label: string; isClaim: boolean }>;
}) {
  const colors = useColors();
  const tone = row.status === "resolved"
    ? colors.success
    : row.status === "rejected"
      ? colors.statusBad
      : row.status === "withdrawn"
        ? colors.mutedForeground
        : row.status === "investigating"
          ? colors.statusMoving
          : colors.statusWarn;
  const typeLabel = types.find((item) => item.type === row.type)?.label ?? humanise(row.type);

  return (
    <Card>
      <View style={styles.caseTop}>
        <View style={styles.flex}>
          <Mono color="#176B2C">{row.code}</Mono>
          <Title style={styles.caseTitle}>{typeLabel}</Title>
        </View>
        <View style={[styles.statusPill, { backgroundColor: `${tone}18`, borderColor: `${tone}55` }]}>
          <Small color={tone}>{humanise(row.status)}</Small>
        </View>
      </View>
      {row.awb ? <Body>AWB: <Mono>{row.awb}</Mono></Body> : null}
      <Body>Claimed: {money(row.claimAmountCents)}</Body>
      <Small numberOfLines={3}>{row.description}</Small>
      <View style={[styles.caseFooter, { borderTopColor: colors.border }]}>
        <Small>Opened {dateTime(row.createdAt)}</Small>
        {row.slaDueAt ? <Small>Reply by {dateTime(row.slaDueAt)}</Small> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  backButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  fieldGroup: { gap: 8 },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  typeOption: { minHeight: Space.minTouch, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, flexGrow: 1, flexBasis: "45%", alignItems: "center", justifyContent: "center" },
  listHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 },
  caseList: { gap: Space.unit },
  caseTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  caseTitle: { fontSize: 16, marginTop: 3 },
  statusPill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5 },
  caseFooter: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 9, flexDirection: "row", justifyContent: "space-between", flexWrap: "wrap", gap: 6 },
});
