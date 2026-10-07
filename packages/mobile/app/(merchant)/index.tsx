import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { apiMessage, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date, dateTime, humanise, money } from "../../lib/format";
import { Screen, ScreenHeader, Section } from "../../components/natex/screen";
import { Card, Empty, Panel, Stat, StatRow } from "../../components/natex/card";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { statusColor } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";

export default function MerchantHome() {
  const colors = useColors();
  const { user } = useAuth();
  const profile = useQuery({
    ...orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 1 } }),
    staleTime: 5 * 60_000,
    select: (result) => result.rows[0] ?? null,
  });
  const summary = useQuery({ ...orpc.parcels.summary.queryOptions(), refetchInterval: 30_000 });
  const statement = useQuery({ ...orpc.finance.statement.queryOptions({ input: {} }), refetchInterval: 60_000 });
  const pickups = useQuery({ ...orpc.collection.pickupRequestCounts.queryOptions({ input: {} }), refetchInterval: 30_000 });
  const ndr = useQuery({ ...orpc.ndr.counts.queryOptions({ input: {} }), refetchInterval: 30_000 });
  const recent = useQuery({
    ...orpc.parcels.list.queryOptions({ input: { page: 1, pageSize: 5 } }),
    refetchInterval: 30_000,
  });
  const error = profile.error ?? summary.error ?? statement.error ?? pickups.error ?? ndr.error ?? recent.error;
  const refresh = () => Promise.all([profile.refetch(), summary.refetch(), statement.refetch(), pickups.refetch(), ndr.refetch(), recent.refetch()]);
  const s = summary.data;
  const openNdr = (ndr.data?.open ?? 0) + (ndr.data?.instructed ?? 0) + (ndr.data?.reattemptScheduled ?? 0);
  const merchant = profile.data;

  return (
    <Screen
      inTabs
      onRefresh={() => { void refresh(); }}
      refreshing={profile.isRefetching || summary.isRefetching || statement.isRefetching || recent.isRefetching}
    >
      <View style={styles.brandRow}>
        <Image
          source={require("../../assets/natex-wordmark.jpg")}
          style={styles.wordmark}
          resizeMode="contain"
          accessibilityLabel="NatEx — We deliver trust too"
        />
        <Small style={styles.brandCaption}>MERCHANT</Small>
      </View>

      <ScreenHeader
        title={`Hello, ${merchant?.contactName?.split(" ")[0] ?? user?.name?.split(" ")[0] ?? "there"}`}
        subtitle={merchant?.name ?? "Your delivery workspace"}
      />

      {error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(error, "Some dashboard information could not be loaded.")}</Body></Panel> : null}
      {merchant?.status && merchant.status !== "active" ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Title color={colors.statusWarn}>Account {humanise(merchant.status)}</Title>
          <Small>New bookings and pickup requests may be unavailable. Please contact NatEx operations.</Small>
        </Panel>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/(merchant)/book")}
        style={({ pressed }) => [styles.bookBanner, { backgroundColor: "#176B2C", opacity: pressed ? 0.9 : 1 }]}
      >
        <View style={styles.bookIcon}><Ionicons name="add" size={28} color="#176B2C" /></View>
        <View style={styles.bookText}>
          <Title color="#FFFFFF">Book a shipment</Title>
          <Small color="#E5F4E8">Create a delivery and get its AWB instantly</Small>
        </View>
        <Ionicons name="arrow-forward" size={22} color="#FFFFFF" />
      </Pressable>

      <Section>
        <Label>YOUR BUSINESS TODAY</Label>
        <StatRow>
          <Stat label="Booked today" value={s?.bookedToday ?? "—"} color="#176B2C" />
          <Stat label="Open shipments" value={s?.open ?? "—"} color="#0E7490" />
          <Stat label="COD in transit" value={s ? money(s.codOpenCents) : "—"} color="#8A5A00" />
        </StatRow>
      </Section>

      <Card onPress={() => router.push("/(merchant)/statement")} accessibilityLabel="Open COD statement">
        <View style={styles.rowBetween}>
          <View style={styles.flex}>
            <Label>COD PAYABLE TO YOU</Label>
            <Title style={styles.money}>{statement.isLoading ? "Loading…" : money(statement.data?.payableCents)}</Title>
            <Small>{statement.data ? `${statement.data.unsettledParcelCount} parcel(s) not yet settled · view statement` : "View payouts, holds and bank details"}</Small>
          </View>
          <Ionicons name="chevron-forward" size={22} color={colors.mutedForeground} />
        </View>
      </Card>

      {openNdr > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/(merchant)/ndr")}
          style={({ pressed }) => [styles.alertCard, { backgroundColor: "#FFF5F4", borderColor: "#F6C7C3", opacity: pressed ? 0.88 : 1 }]}
        >
          <View style={styles.alertIcon}><Ionicons name="alert-circle" size={22} color="#B42318" /></View>
          <View style={styles.flex}>
            <Title color="#8A1C13">{openNdr} shipment{openNdr === 1 ? "" : "s"} need your answer</Title>
            <Small color="#6F302B">Resolve failed deliveries before the response deadline.</Small>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#8A1C13" />
        </Pressable>
      ) : null}

      <Card>
        <View style={styles.rowBetween}>
          <Title>Pickups</Title>
          <Pressable accessibilityRole="button" onPress={() => router.push("/(merchant)/pickups")} hitSlop={12}>
            <Body color="#176B2C">View all</Body>
          </Pressable>
        </View>
        <View style={styles.pickupRow}>
          <PickupCount label="Awaiting NatEx" value={pickups.data?.requested ?? 0} color={colors.primary} />
          <PickupCount label="Scheduled" value={pickups.data?.scheduled ?? 0} color={colors.success} />
          <PickupCount label="Cancelled" value={pickups.data?.cancelled ?? 0} color={colors.mutedForeground} />
        </View>
      </Card>

      <Section>
        <View style={styles.rowBetween}>
          <Title>Recent shipments</Title>
          <Pressable accessibilityRole="button" onPress={() => router.push("/(merchant)/shipments")} hitSlop={12}>
            <Body color="#176B2C">See all</Body>
          </Pressable>
        </View>
        {recent.isLoading ? (
          <Panel><Small>Loading recent shipments…</Small></Panel>
        ) : (recent.data?.rows.length ?? 0) > 0 ? (
          recent.data!.rows.map((row) => (
            <Card
              key={row.id}
              onPress={() => router.push({ pathname: "/(merchant)/shipment/[awb]", params: { awb: row.awb } })}
              accessibilityLabel={`Track shipment ${row.awb}`}
            >
              <View style={styles.rowBetween}>
                <View style={styles.flex}>
                  <Mono>{row.awb}</Mono>
                  <Body>{row.consigneeName}</Body>
                  <Small>{dateTime(row.createdAt)} · {row.codAmountCents > 0 ? `COD ${money(row.codAmountCents)}` : "Prepaid"}</Small>
                </View>
                <View style={[styles.statusDot, { backgroundColor: statusColor(row.status) }]} />
              </View>
              <Small>{humanise(row.status)}</Small>
            </Card>
          ))
        ) : (
          <Empty title="No shipments yet" detail="Book your first shipment to get started." />
        )}
      </Section>
      <Small style={styles.refreshStamp}>Updated {s?.generatedAt ? date(s.generatedAt) : "when connected"}</Small>
    </Screen>
  );
}

function PickupCount({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.pickupCount}>
      <Mono color={color}>{value}</Mono>
      <Small style={styles.pickupLabel}>{label}</Small>
    </View>
  );
}

const styles = StyleSheet.create({
  brandRow: { alignItems: "center", gap: 2, marginTop: 2, marginBottom: 4 },
  wordmark: { width: 148, height: 48 },
  brandCaption: { letterSpacing: 1.5, fontSize: 11, color: "#176B2C" },
  bookBanner: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 16 },
  bookIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", backgroundColor: "#FFFFFF", borderRadius: 14 },
  bookText: { flex: 1, gap: 2 },
  flex: { flex: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  money: { marginTop: 5, marginBottom: 2, fontSize: 17 },
  alertCard: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, padding: 14 },
  alertIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#FCE5E2", alignItems: "center", justifyContent: "center" },
  pickupRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 6 },
  pickupCount: { alignItems: "center", flex: 1, gap: 4 },
  pickupLabel: { textAlign: "center" },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 4 },
  refreshStamp: { textAlign: "center", marginTop: 4 },
});
