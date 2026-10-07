import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, View } from "react-native";
import { apiMessage, orpc } from "../../../lib/api";
import { dateTime, humanise, money } from "../../../lib/format";
import { Screen } from "../../../components/natex/screen";
import { Card, Empty, Panel } from "../../../components/natex/card";
import { Awb, Body, Label, Mono, Small, Title } from "../../../components/natex/text";
import { useColors } from "../../../hooks/use-colors";
import { statusColor } from "../../../constants/theme";

export default function MerchantShipmentDetail() {
  const colors = useColors();
  const params = useLocalSearchParams<{ awb?: string | string[] }>();
  const awb = Array.isArray(params.awb) ? params.awb[0] ?? "" : params.awb ?? "";
  const detail = useQuery({ ...orpc.parcels.get.queryOptions({ input: { awbOrId: awb } }), enabled: awb.length >= 3 });
  const item = detail.data?.parcel;
  const tone = statusColor(item?.status);

  return (
    <Screen>
      <View style={styles.topLine}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={[styles.back, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="arrow-back" size={20} color={colors.foreground} />
        </Pressable>
        <Label>SHIPMENT TRACKING</Label>
      </View>
      {detail.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(detail.error, "Shipment details could not be loaded.")}</Body></Panel> : null}
      {detail.isLoading ? <Panel><Small>Loading shipment details…</Small></Panel> : item ? (
        <>
          <Card style={styles.hero}>
            <Label>AWB NUMBER</Label>
            <Awb color="#176B2C" style={styles.awb}>{item.awb}</Awb>
            <View style={[styles.statusBadge, { backgroundColor: `${tone}12`, borderColor: `${tone}55` }]}>
              <View style={[styles.statusDot, { backgroundColor: tone }]} />
              <Small color={tone}>{humanise(item.status)}</Small>
            </View>
            <Small>Booked {dateTime(item.createdAt)}</Small>
          </Card>

          <Card>
            <Title>Delivery details</Title>
            <View style={styles.detailGrid}>
              <Field label="Consignee" value={item.consigneeName} />
              <Field label="Phone" value={item.consigneePhone} mono />
              <Field label="Delivery address" value={item.destAddress} />
              <Field label="COD amount" value={item.codAmountCents > 0 ? money(item.codAmountCents) : "Prepaid"} mono />
              <Field label="Weight" value={`${(item.weightGrams / 1000).toFixed(2)} kg`} mono />
            </View>
          </Card>

          <Card>
            <View style={styles.rowBetween}>
              <Title>Tracking timeline</Title>
              <Small>{detail.data?.timeline.length ?? 0} updates</Small>
            </View>
            {detail.data?.timeline.length ? (
              <View style={styles.timeline}>
                {detail.data.timeline.slice().reverse().map((event, index) => (
                  <View key={event.id} style={styles.eventRow}>
                    <View style={styles.timelineRail}>
                      <View style={[styles.timelineDot, { backgroundColor: index === 0 ? "#176B2C" : colors.border }]} />
                      {index < detail.data!.timeline.length - 1 ? <View style={[styles.timelineLine, { backgroundColor: colors.border }]} /> : null}
                    </View>
                    <View style={styles.eventBody}>
                      <View style={styles.rowBetween}>
                        <Body style={styles.eventTitle}>{humanise(event.toStatus)}</Body>
                        <Small>{dateTime(event.ts)}</Small>
                      </View>
                      {event.notes ? <Small>{event.notes}</Small> : null}
                      {event.actorName ? <Small>Updated by {event.actorName}</Small> : null}
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Empty title="No tracking updates yet" detail="Updates appear as NatEx receives and moves your parcel." />
            )}
          </Card>
        </>
      ) : !detail.isError ? <Empty title="Shipment not found" detail="Check the AWB and try again." /> : null}
    </Screen>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <View style={styles.field}><Label>{label}</Label>{mono ? <Mono>{value}</Mono> : <Body>{value}</Body>}</View>;
}

const styles = StyleSheet.create({
  topLine: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  back: { width: 44, height: 44, borderWidth: 1, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  hero: { alignItems: "center", gap: 10, paddingVertical: 24 },
  awb: { fontSize: 23 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 7, borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 6 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  detailGrid: { gap: 15 },
  field: { gap: 4 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  timeline: { marginTop: 4 },
  eventRow: { flexDirection: "row", minHeight: 64, gap: 12 },
  timelineRail: { alignItems: "center", width: 16 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  timelineLine: { width: 2, flex: 1, marginTop: 3 },
  eventBody: { flex: 1, gap: 4, paddingBottom: 16 },
  eventTitle: { fontFamily: "IBMPlexSans_500Medium" },
});
