import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, View } from "react-native";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Screen } from "../../components/natex/screen";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { apiMessage, orpc } from "../../lib/api";
import { date, dateTime, humanise, money } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";

export default function MerchantStatement() {
  const colors = useColors();
  const statement = useQuery({
    ...orpc.finance.statement.queryOptions({ input: {} }),
    refetchInterval: 60_000,
  });
  const data = statement.data;
  const lastPaid = data?.settlements.find((row) => row.status === "paid") ?? null;
  const back = () => router.back();

  return (
    <Screen onRefresh={() => { void statement.refetch(); }} refreshing={statement.isRefetching}>
      <View style={styles.topRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={back} style={[styles.backButton, { borderColor: colors.border, backgroundColor: colors.card }]}><Ionicons name="arrow-back" size={19} color={colors.foreground} /></Pressable>
        <View style={styles.flex}><Label>MERCHANT FINANCE</Label><Title>COD & settlements</Title></View>
      </View>
      <Small>See what NatEx owes your account, payout status and any amounts held back.</Small>

      {statement.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(statement.error, "Your statement could not be loaded.")}</Body></Panel> : null}
      {statement.isLoading ? <Panel><Small>Loading your COD statement…</Small></Panel> : data ? (
        <>
          <Card style={styles.balanceCard}>
            <Label>COD PAYABLE TO YOU</Label>
            <Title style={styles.balance}>{money(data.payableCents)}</Title>
            <Small>{data.unsettledParcelCount} parcel{data.unsettledParcelCount === 1 ? "" : "s"} not yet settled</Small>
          </Card>

          <StatRow>
            <Stat label="Last paid payout" value={lastPaid ? money(lastPaid.netCents) : "—"} color="#176B2C" />
            <Stat label="Open holds" value={data.openHolds.length} color={data.openHolds.length ? colors.statusWarn : colors.success} />
          </StatRow>

          <Card>
            <Title>Where NatEx pays you</Title>
            {data.payout ? (
              <View style={styles.fields}>
                <Field label="Beneficiary" value={data.payout.beneficiaryName} />
                <Field label="Bank" value={data.payout.bankName} />
                <Field label="Branch" value={data.payout.branchName} />
                <Field label="Account" value={maskAccount(data.payout.accountNumber)} mono />
                <View style={[styles.verification, { backgroundColor: data.payout.verified ? "#E7F5EC" : "#FFF7E8" }]}>
                  <Ionicons name={data.payout.verified ? "checkmark-circle" : "alert-circle"} size={17} color={data.payout.verified ? "#176B2C" : "#9A6700"} />
                  <Small color={data.payout.verified ? "#176B2C" : "#9A6700"}>{data.payout.verified ? "Bank details verified" : "Bank details not yet verified"}</Small>
                </View>
              </View>
            ) : (
              <Panel style={{ borderColor: colors.statusWarn }}><Small color={colors.statusWarn}>No payout bank details are on file. Contact NatEx finance with a bank letter or cancelled cheque.</Small></Panel>
            )}
            <Small>Bank details are maintained by NatEx finance for your protection.</Small>
          </Card>

          <Card>
            <Title>Recent payouts</Title>
            {data.settlements.length ? data.settlements.slice(0, 8).map((row) => (
              <View key={row.id} style={[styles.listRow, { borderBottomColor: colors.border }]}>
                <View style={styles.flex}>
                  <Mono color="#176B2C">{row.code}</Mono>
                  <Small>{date(row.periodStart)} – {date(row.periodEnd)} · {row.paidAt ? `Paid ${dateTime(row.paidAt)}` : humanise(row.status)}</Small>
                  {row.utr ? <Small>Bank ref {row.utr}</Small> : null}
                </View>
                <View style={styles.alignRight}>
                  <Mono>{money(row.netCents)}</Mono>
                  <StatusText status={row.status} />
                </View>
              </View>
            )) : <Empty title="No payouts yet" detail="A payout appears here once NatEx finance approves it." />}
            {lastPaid ? <Small>Latest paid: {lastPaid.code} · {date(lastPaid.paidAt)}</Small> : null}
          </Card>

          <Card>
            <View style={styles.rowBetween}><Title>Amounts held back</Title><Small>{data.openHolds.length}</Small></View>
            {data.openHolds.length ? data.openHolds.map((hold) => (
              <View key={hold.id} style={[styles.holdRow, { borderBottomColor: colors.border }]}>
                <View style={styles.flex}>
                  <Body>{hold.scope === "merchant" ? "All payouts" : hold.awb ?? "One parcel"}</Body>
                  <Small>{humanise(hold.reason)} · {hold.detail}</Small>
                </View>
                <Mono>{hold.amountCents === null ? "—" : money(hold.amountCents)}</Mono>
              </View>
            )) : <Empty title="Nothing is held back" detail="Open holds will be explained here." />}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return <View style={styles.field}><Label>{label}</Label>{mono ? <Mono>{value ?? "—"}</Mono> : <Body>{value ?? "—"}</Body>}</View>;
}

function StatusText({ status }: { status: string }) {
  const colors = useColors();
  const good = status === "paid";
  const warn = status === "on_hold";
  return <Small color={good ? "#176B2C" : warn ? colors.statusWarn : colors.mutedForeground}>{humanise(status)}</Small>;
}

function maskAccount(account: string): string {
  const last = account.replace(/\s/g, "").slice(-4);
  return last ? `•••• ${last}` : "••••";
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  backButton: { width: 44, height: 44, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  balanceCard: { backgroundColor: "#176B2C", borderColor: "#176B2C", paddingVertical: 22 },
  balance: { color: "#FFFFFF", fontSize: 27, marginTop: 5 },
  fields: { gap: 12 },
  field: { gap: 3 },
  verification: { minHeight: 40, borderRadius: 10, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 7 },
  listRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 11 },
  alignRight: { alignItems: "flex-end", gap: 4 },
  holdRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 11 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
