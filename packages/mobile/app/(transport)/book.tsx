import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { AddressFields, EMPTY_ADDRESS, formatAddress, isCompleteAddress, type AddressParts } from "../../components/natex/address-fields";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { apiMessage, client, orpc } from "../../lib/api";
import { parseRupeesToCents } from "../../lib/format";
import { parseKilograms } from "../../lib/weight";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

type Form = {
  merchantId: string;
  initialStatus: "Booked" | "AtOriginHub";
  awb: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  declaredValue: string;
  codAmount: string;
  codIncludesDeliveryCharge: boolean;
  originAddress: AddressParts;
  consigneeName: string;
  consigneePhone: string;
  destAddress: AddressParts;
  destLat: string;
  destLng: string;
};

const EMPTY: Form = {
  merchantId: "", initialStatus: "Booked", awb: "", weightKg: "1", lengthCm: "", widthCm: "", heightCm: "",
  declaredValue: "0", codAmount: "0", codIncludesDeliveryCharge: false, originAddress: { ...EMPTY_ADDRESS },
  consigneeName: "", consigneePhone: "", destAddress: { ...EMPTY_ADDRESS }, destLat: "", destLng: "",
};

export default function OpsBookNative() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [successAwb, setSuccessAwb] = React.useState<string | null>(null);
  const [merchantPicker, setMerchantPicker] = React.useState(false);
  const merchants = useQuery(orpc.merchants.options.queryOptions({}));
  const selectedMerchant = merchants.data?.find((item) => item.id === form.merchantId);
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => { setError(null); setForm((current) => ({ ...current, [key]: value })); };
  const setMerchant = (merchantId: string) => {
    const merchant = merchants.data?.find((item) => item.id === merchantId);
    setForm((current) => ({ ...current, merchantId, originAddress: merchant?.address ? { ...EMPTY_ADDRESS, line1: merchant.address } : current.originAddress }));
    setMerchantPicker(false); setError(null);
  };
  const hasCoords = form.destLat.trim() !== "" && form.destLng.trim() !== "";
  const serviceability = useQuery({ ...orpc.routing.checkServiceability.queryOptions({ input: { lat: Number(form.destLat), lng: Number(form.destLng) } }), enabled: hasCoords && Number.isFinite(Number(form.destLat)) && Number.isFinite(Number(form.destLng)) });
  const create = useMutation({
    mutationFn: () => client.parcels.create({
      merchantId: form.merchantId, initialStatus: form.initialStatus, awb: form.awb.trim() || null,
      weightGrams: parseKilograms(form.weightKg) ?? 0, lengthCm: form.lengthCm ? Number(form.lengthCm) : null,
      widthCm: form.widthCm ? Number(form.widthCm) : null, heightCm: form.heightCm ? Number(form.heightCm) : null,
      declaredValueCents: parseRupeesToCents(form.declaredValue) ?? 0, codAmountCents: parseRupeesToCents(form.codAmount) ?? 0,
      codIncludesDeliveryCharge: form.codIncludesDeliveryCharge, originAddress: formatAddress(form.originAddress),
      consigneeName: form.consigneeName.trim(), consigneePhone: form.consigneePhone.trim(), destAddress: formatAddress(form.destAddress),
      destLat: hasCoords ? Math.round(Number(form.destLat) * 1_000_000) : null, destLng: hasCoords ? Math.round(Number(form.destLng) * 1_000_000) : null,
      destZoneId: serviceability.data?.zone?.id ?? null,
    }),
    onSuccess: (result) => { setSuccessAwb(result.parcel.awb); setForm({ ...EMPTY, merchantId: form.merchantId }); void queryClient.invalidateQueries(); },
  });
  const submit = () => {
    setError(null);
    if (!form.merchantId) return setError("Select a merchant.");
    if (!isCompleteAddress(form.originAddress)) return setError("Complete the pickup address with line 1, district and province.");
    if (!isCompleteAddress(form.destAddress)) return setError("Complete the delivery address with line 1, district and province.");
    if (!form.consigneeName.trim() || form.consigneeName.trim().length < 2) return setError("Enter the consignee name.");
    if (form.consigneePhone.trim().length < 9) return setError("Enter a valid consignee phone number.");
    if (!parseKilograms(form.weightKg)) return setError("Enter a valid parcel weight in kilograms.");
    if (parseRupeesToCents(form.declaredValue) === null || parseRupeesToCents(form.codAmount) === null) return setError("Enter valid rupee amounts.");
    if ([form.lengthCm, form.widthCm, form.heightCm].some((value) => value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 500))) return setError("Dimensions must be whole centimetres from 1 to 500.");
    create.mutate();
  };
  return <Screen footer={successAwb ? <Button title="Book another parcel" onPress={() => { setSuccessAwb(null); setForm({ ...EMPTY, merchantId: form.merchantId }); }} /> : <Button title="Create booking" loading={create.isPending} onPress={submit} />}>
    <ScreenHeader title="Book a Parcel" subtitle="Native hub booking with the same fields and rules as NOS" />
    {error || create.isError ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error ?? apiMessage(create.error, "The parcel could not be booked.")}</Body></Panel> : null}
    {successAwb ? <Card><Title>Shipment booked</Title><Body>{successAwb}</Body><Small>The parcel was saved successfully and is ready for the next hub operation.</Small><Button title="Back to Ops" variant="secondary" onPress={() => router.replace("/(transport)")} /></Card> : <>
      <Card><Title>Merchant & booking</Title><Label>Merchant</Label><Pressable onPress={() => setMerchantPicker(true)} style={[styles.select, { borderColor: colors.border, backgroundColor: colors.surface }]}><Body>{selectedMerchant?.name ?? "Select merchant"}</Body></Pressable>{selectedMerchant ? <Small>Pickup address: {selectedMerchant.address || "Enter or update the pickup address below."}</Small> : null}<Label>Initial status</Label><View style={styles.row}><Choice label="Booked" selected={form.initialStatus === "Booked"} onPress={() => set("initialStatus")("Booked")} /><Choice label="At Origin Hub" selected={form.initialStatus === "AtOriginHub"} onPress={() => set("initialStatus")("AtOriginHub")} /></View><Input label="Tracking number (optional)" value={form.awb} onChangeText={set("awb")} code placeholder="NX1234567890" /></Card>
      <Card><Title>Pickup address</Title><AddressFields value={form.originAddress} onChange={set("originAddress")} /></Card>
      <Card><Title>Consignee</Title><Input label="Full name" value={form.consigneeName} onChangeText={set("consigneeName")} /><Input label="Phone number" value={form.consigneePhone} onChangeText={set("consigneePhone")} keyboardType="phone-pad" /><AddressFields value={form.destAddress} onChange={set("destAddress")} /><Input label="Destination latitude (optional)" value={form.destLat} onChangeText={set("destLat")} keyboardType="decimal-pad" /><Input label="Destination longitude (optional)" value={form.destLng} onChangeText={set("destLng")} keyboardType="decimal-pad" />{serviceability.data?.zone ? <Small>Service zone: {serviceability.data.zone.name}</Small> : null}</Card>
      <Card><Title>Parcel details</Title><Input label="Weight (kg)" value={form.weightKg} onChangeText={set("weightKg")} keyboardType="decimal-pad" /><View style={styles.row}><Input label="Length (cm)" value={form.lengthCm} onChangeText={set("lengthCm")} keyboardType="number-pad" /><Input label="Width (cm)" value={form.widthCm} onChangeText={set("widthCm")} keyboardType="number-pad" /><Input label="Height (cm)" value={form.heightCm} onChangeText={set("heightCm")} keyboardType="number-pad" /></View><Input label="Declared value (Rs.)" value={form.declaredValue} onChangeText={set("declaredValue")} keyboardType="decimal-pad" /></Card>
      <Card><Title>Payment on delivery</Title><Input label="COD to collect (Rs.)" value={form.codAmount} onChangeText={set("codAmount")} keyboardType="decimal-pad" /><Choice label="Included delivery charge" selected={form.codIncludesDeliveryCharge} onPress={() => set("codIncludesDeliveryCharge")(!form.codIncludesDeliveryCharge)} /></Card>
    </>}
    <Modal visible={merchantPicker} transparent animationType="slide" onRequestClose={() => setMerchantPicker(false)}><Pressable style={styles.backdrop} onPress={() => setMerchantPicker(false)}><View style={[styles.sheet, { backgroundColor: colors.card }]}><Title>Select merchant</Title>{(merchants.data ?? []).map((merchant) => <Pressable key={merchant.id} onPress={() => setMerchant(merchant.id)} style={styles.merchantRow}><Body>{merchant.name}</Body><Small>{merchant.address || "Address not recorded"}</Small></Pressable>)}{merchants.isSuccess && merchants.data?.length === 0 ? <Empty title="No merchants available" detail="No merchant is visible in this hub scope." /> : null}</View></Pressable></Modal>
  </Screen>;
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) { const colors = useColors(); return <Pressable onPress={onPress} style={[styles.choice, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary : "transparent" }]}><Body color={selected ? colors.primaryForeground : colors.foreground}>{selected ? "✓ " : ""}{label}</Body></Pressable>; }
const styles = StyleSheet.create({ row: { flexDirection: "row", gap: Space.unit, flexWrap: "wrap" }, select: { minHeight: 50, borderWidth: 1, borderRadius: Space.radius, paddingHorizontal: Space.card, justifyContent: "center", marginBottom: Space.unit }, choice: { minHeight: 44, borderWidth: 1, borderRadius: Space.radiusPill, paddingHorizontal: Space.card, justifyContent: "center" }, backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.55)", justifyContent: "flex-end" }, sheet: { maxHeight: "80%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: Space.page }, merchantRow: { paddingVertical: Space.unit, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#64748b" } });
