import { useState } from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { apiMessage, orpc } from "../../lib/api";
import { dateTime, humanise, money } from "../../lib/format";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Body, Label, Mono, Small, Title } from "../../components/natex/text";
import { useColors } from "../../hooks/use-colors";
import { Space, statusColor } from "../../constants/theme";

const FILTERS = [
  { label: "All", value: "" },
  { label: "Booked", value: "Booked" },
  { label: "Moving", value: "InTransit" },
  { label: "Delivered", value: "Delivered" },
  { label: "Needs attention", value: "DeliveryAttempted" },
] as const;

type FilterValue = (typeof FILTERS)[number]["value"];

export default function MerchantShipments() {
  const colors = useColors();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<FilterValue>("");
  const [page, setPage] = useState(1);
  const input = {
    page,
    pageSize: 20,
    search: search.trim() || undefined,
    status: status ? [status] : undefined,
  };
  const list = useQuery({
    ...orpc.parcels.list.queryOptions({ input }),
    placeholderData: (previous) => previous,
  });
  const rows = list.data?.rows ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 20));

  return (
    <Screen inTabs onRefresh={() => { void list.refetch(); }} refreshing={list.isRefetching}>
      <ScreenHeader title="Shipments" subtitle="Search, track and review every parcel booked to your account." />

      <View style={[styles.searchWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.mutedForeground} />
        <TextInput
          value={search}
          onChangeText={(value) => { setSearch(value); setPage(1); }}
          placeholder="AWB, name or phone"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search shipments by AWB, consignee, or phone"
          style={[styles.searchInput, { color: colors.foreground }]}
        />
        {search ? <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setSearch("")}><Ionicons name="close-circle" size={20} color={colors.mutedForeground} /></Pressable> : null}
      </View>

      <View style={styles.filters}>
        {FILTERS.map((item) => {
          const selected = status === item.value;
          return (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => { setStatus(item.value); setPage(1); }}
              style={[styles.filterChip, { backgroundColor: selected ? "#176B2C" : colors.card, borderColor: selected ? "#176B2C" : colors.border }]}
            >
              <Small color={selected ? "#FFFFFF" : colors.foreground}>{item.label}</Small>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.resultsHeader}>
        <Label>{list.data ? `${list.data.total} SHIPMENTS` : "YOUR SHIPMENTS"}</Label>
        <Small>Page {list.data?.page ?? page} of {pages}</Small>
      </View>

      {list.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(list.error, "Shipments could not be loaded.")}</Body></Panel> : null}
      {list.isLoading ? (
        <Panel><Small>Loading shipments…</Small></Panel>
      ) : rows.length ? (
        rows.map((row) => {
          const tone = statusColor(row.status);
          return (
            <Card
              key={row.id}
              onPress={() => router.push({ pathname: "/(merchant)/shipment/[awb]", params: { awb: row.awb } })}
              accessibilityLabel={`Open shipment ${row.awb}, ${humanise(row.status)}`}
            >
              <View style={styles.rowBetween}>
                <View style={styles.flex}>
                  <Mono color="#176B2C">{row.awb}</Mono>
                  <Title style={styles.consignee}>{row.consigneeName}</Title>
                  <Small>{row.consigneePhone}</Small>
                </View>
                <View style={[styles.statusBadge, { borderColor: `${tone}55`, backgroundColor: `${tone}12` }]}>
                  <Small color={tone}>{humanise(row.status)}</Small>
                </View>
              </View>
              <View style={styles.rowBetween}>
                <Small numberOfLines={1} style={styles.address}>{row.destAddress}</Small>
                <Small>{row.codAmountCents > 0 ? `COD ${money(row.codAmountCents)}` : "Prepaid"}</Small>
              </View>
              <View style={[styles.footerLine, { borderTopColor: colors.border }]}>
                <Small>Booked {dateTime(row.createdAt)}</Small>
                <Body color="#176B2C">Track <Ionicons name="arrow-forward" size={14} color="#176B2C" /></Body>
              </View>
            </Card>
          );
        })
      ) : (
        <Empty title="No shipments found" detail={search || status ? "Try another search or status filter." : "Book a parcel to see its delivery progress here."} />
      )}

      {pages > 1 ? (
        <View style={styles.pagination}>
          <Pressable disabled={page <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} accessibilityRole="button" style={[styles.pageButton, { borderColor: colors.border, opacity: page <= 1 ? 0.45 : 1 }]}>
            <Ionicons name="chevron-back" size={18} color={colors.foreground} /><Small>Previous</Small>
          </Pressable>
          <Pressable disabled={page >= pages} onPress={() => setPage((p) => Math.min(pages, p + 1))} accessibilityRole="button" style={[styles.pageButton, { borderColor: colors.border, opacity: page >= pages ? 0.45 : 1 }]}>
            <Small>Next</Small><Ionicons name="chevron-forward" size={18} color={colors.foreground} />
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14 },
  searchInput: { flex: 1, minHeight: 48, fontSize: 15, fontFamily: "IBMPlexSans_400Regular" },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filterChip: { minHeight: 38, paddingHorizontal: 13, borderWidth: 1, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  resultsHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 2 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  flex: { flex: 1 },
  consignee: { fontSize: 16, marginTop: 5 },
  statusBadge: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 },
  address: { flex: 1, marginTop: 2 },
  footerLine: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4, paddingTop: 10, flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  pagination: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  pageButton: { minHeight: Space.minTouch, paddingHorizontal: 14, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
});
