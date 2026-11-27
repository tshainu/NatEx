import React from "react";
import { Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { AddressFields, DISTRICTS_BY_PROVINCE, EMPTY_ADDRESS, formatAddress, isCompleteAddress, type AddressParts } from "../../components/natex/address-fields";
import { BarcodeScanner } from "../../components/natex/barcode-scanner";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { apiMessage, client, orpc } from "../../lib/api";
import { parseRupeesToCents } from "../../lib/format";
import { parseKilograms } from "../../lib/weight";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

type Form = { merchantId: string; initialStatus: "Booked" | "AtOriginHub"; awb: string; weightKg: string; lengthCm: string; widthCm: string; heightCm: string; declaredValue: string; codAmount: string; codIncludesDeliveryCharge: boolean; originAddress: AddressParts; consigneeName: string; consigneePhone: string; destAddress: AddressParts };
const EMPTY: Form = { merchantId: "", initialStatus: "Booked", awb: "", weightKg: "1", lengthCm: "", widthCm: "", heightCm: "", declaredValue: "0", codAmount: "0", codIncludesDeliveryCharge: false, originAddress: { ...EMPTY_ADDRESS }, consigneeName: "", consigneePhone: "", destAddress: { ...EMPTY_ADDRESS } };

function merchantAddress(address: string): AddressParts {
  const lower = address.toLowerCase();
  const entry = Object.entries(DISTRICTS_BY_PROVINCE).find(([, districts]) => districts.some((district) => lower.includes(district.toLowerCase())));
  const district = entry?.[1].find((item) => lower.includes(item.toLowerCase())) ?? "";
  const province = entry?.[0] ?? "";
  return { ...EMPTY_ADDRESS, line1: address, district: district as AddressParts["district"], province: province as AddressParts["province"] };
}

export default function OpsBookNative() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [error, setError] = React.useState<string | null>(null);
  const [successAwb, setSuccessAwb] = React.useState<string | null>(null);
  const [merchantPicker, setMerchantPicker] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [checkedAwb, setCheckedAwb] = React.useState({ merchantId: "", awb: "" });
  const merchants = useQuery(orpc.merchants.options.queryOptions({}));
  const selectedMerchant = merchants.data?.find((item) => item.id === form.merchantId);
  const set = <K extends keyof Form>(key: K) => (value: Form[K]) => { setError(null); setForm((current) => ({ ...current, [key]: value })); };
  const setMerchant = (merchantId: string) => {
    const merchant = merchants.data?.find((item) => item.id === merchantId);
    setForm((current) => ({ ...current, merchantId, originAddress: merchant?.address ? merchantAddress(merchant.address) : { ...EMPTY_ADDRESS } }));
    setMerchantPicker(false); setError(null);
  };
  React.useEffect(() => { const timer = setTimeout(() => setCheckedAwb({ merchantId: form.merchantId, awb: form.awb.trim().toUpperCase() }), 300); return () => clearTimeout(timer); }, [form.awb, form.merchantId]);
  const enteredAwb = form.awb.trim().toUpperCase();
  const awbFormatValid = /^NX\d{10}$/.test(enteredAwb);
  const awbCheck = useQuery({ queryKey: ["native-book-awb", checkedAwb.merchantId, checkedAwb.awb], queryFn: () => client.awbBatches.checkForMerchantBooking(checkedAwb), enabled: checkedAwb.merchantId === form.merchantId && checkedAwb.awb === enteredAwb && Boolean(form.merchantId) && awbFormatValid, retry: false, staleTime: 0 });
  const awbError = enteredAwb && !awbFormatValid ? "Enter a valid 12-character NX tracking number." : awbCheck.data && !awbCheck.data.valid ? awbCheck.data.reason : awbCheck.isError ? "Could not verify this tracking number. Check your connection and try again." : null;
  const originDistrict = form.originAddress.district;
  const band = originDistrict && form.destAddress.district && originDistrict === form.destAddress.district ? "local" : "outstation";
  const quote = useQuery({ ...orpc.rateCards.quoteForMerchant.queryOptions({ input: { merchantId: form.merchantId, band, weightGrams: parseKilograms(form.weightKg) ?? 0, lengthCm: form.lengthCm ? Number(form.lengthCm) : null, widthCm: form.widthCm ? Number(form.widthCm) : null, heightCm: form.heightCm ? Number(form.heightCm) : null, requested: [] } }), enabled: Boolean(form.merchantId && (parseKilograms(form.weightKg) ?? 0) > 0 && form.destAddress.district), retry: false });
  const create = useMutation({ mutationFn: () => client.parcels.create({ merchantId: form.merchantId, initialStatus: form.initialStatus, awb: enteredAwb, weightGrams: parseKilograms(form.weightKg) ?? 0, lengthCm: form.lengthCm ? Number(form.lengthCm) : null, widthCm: form.widthCm ? Number(form.widthCm) : null, heightCm: form.heightCm ? Number(form.heightCm) : null, declaredValueCents: parseRupeesToCents(form.declaredValue) ?? 0, codAmountCents: parseRupeesToCents(form.codAmount) ?? 0, codIncludesDeliveryCharge: form.codIncludesDeliveryCharge, originAddress: formatAddress(form.originAddress), consigneeName: form.consigneeName.trim(), consigneePhone: form.consigneePhone.trim(), destAddress: formatAddress(form.destAddress), destLat: null, destLng: null, destZoneId: null }), onSuccess: (result) => { setSuccessAwb(result.parcel.awb); setForm({ ...EMPTY, merchantId: form.merchantId }); void queryClient.invalidateQueries(); } });
  const submit = () => { setError(null); if (!form.merchantId) return setError("Select a merchant."); if (!awbFormatValid || !awbCheck.data?.valid) return setError(awbError ?? "Scan or enter a valid tracking number. Tracking number is mandatory."); if (!isCompleteAddress(form.originAddress)) return setError("The selected merchant address needs a district and province."); if (!isCompleteAddress(form.destAddress)) return setError("Complete the delivery address with line 1, district and province."); if (!form.consigneeName.trim() || form.consigneeName.trim().length < 2) return setError("Enter the consignee name."); if (form.consigneePhone.trim().length < 9) return setError("Enter a valid consignee phone number."); if (!parseKilograms(form.weightKg)) return setError("Enter a valid parcel weight in kilograms."); if (parseRupeesToCents(form.declaredValue) === null || parseRupeesToCents(form.codAmount) === null) return setError("Enter valid rupee amounts."); create.mutate(); };
  return <Screen footer={successAwb ? <Button title="Book another parcel" onPress={() => { setSuccessAwb(null); setForm({ ...EMPTY, merchantId: form.merchantId }); }} /> : <Button title="Create booking" loading={create.isPending} onPress={submit} />}>
    <ScreenHeader title="Book a Parcel" subtitle="Native hub booking with the same fields and rules as NOS" />
    {error || create.isError ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error ?? apiMessage(create.error, "The parcel could not be booked.")}</Body></Panel> : null}
    {successAwb ? <Card><Title>Shipment booked</Title><Body>{successAwb}</Body><Small>The parcel was saved successfully and is ready for the next hub operation.</Small><Button title="Back to Ops" variant="secondary" onPress={() => router.replace("/(transport)")} /></Card> : <>
      <Card><Title>Merchant & booking</Title><Label>Merchant</Label><Pressable onPress={() => setMerchantPicker(true)} style={[styles.select, { borderColor: colors.border, backgroundColor: colors.surface }]}><Body>{selectedMerchant?.name ?? "Select merchant"}</Body></Pressable>{selectedMerchant ? <View style={styles.addressLine}><View style={styles.flex}><Small>Pickup address</Small><Body>{selectedMerchant.address || "Address not recorded"}</Body><Small>{form.originAddress.district || "District not found"} · {form.originAddress.province || "Province not found"}</Small></View>{selectedMerchant.lat != null && selectedMerchant.lng != null ? <Pressable accessibilityLabel="Open merchant location in Google Maps" onPress={() => void Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${(selectedMerchant.lat ?? 0) / 1_000_000},${(selectedMerchant.lng ?? 0) / 1_000_000}`)}><Ionicons name="map-outline" size={22} color={colors.primary} /></Pressable> : null}</View> : null}<Label>Initial status</Label><View style={styles.row}><Choice label="Booked" selected={form.initialStatus === "Booked"} onPress={() => set("initialStatus")("Booked")} /><Choice label="At Origin Hub" selected={form.initialStatus === "AtOriginHub"} onPress={() => set("initialStatus")("AtOriginHub")} /></View><Input label="Tracking number *" value={form.awb} onChangeText={(value) => set("awb")(value.trim().toUpperCase())} code error={awbError} hint={!awbError && awbCheck.data?.valid ? "Allocated to this merchant and available." : "Required. Scan the barcode on the tracking label or enter it manually."} placeholder="NX1234567890" /><Button title="Scan tracking number" variant="secondary" onPress={() => setScanning(true)} /></Card>
      <Card><Title>Consignee</Title><Input label="Full name" value={form.consigneeName} onChangeText={set("consigneeName")} /><Input label="Phone number" value={form.consigneePhone} onChangeText={set("consigneePhone")} keyboardType="phone-pad" /><AddressFields value={form.destAddress} onChange={set("destAddress")} /></Card>
      <Card><Title>Parcel details</Title><Input label="Weight (kg)" value={form.weightKg} onChangeText={set("weightKg")} keyboardType="decimal-pad" /><View style={styles.row}><Input label="Length (cm)" value={form.lengthCm} onChangeText={set("lengthCm")} keyboardType="number-pad" /><Input label="Width (cm)" value={form.widthCm} onChangeText={set("widthCm")} keyboardType="number-pad" /><Input label="Height (cm)" value={form.heightCm} onChangeText={set("heightCm")} keyboardType="number-pad" /></View><Input label="Declared value (Rs.)" value={form.declaredValue} onChangeText={set("declaredValue")} keyboardType="decimal-pad" />{quote.data ? <Panel><Body>Applicable rate-card price: <Body style={{ fontWeight: "700" }}>Rs. {(quote.data.totalCents / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 })}</Body></Body><Small>{quote.data.rateCard.code} · {band} · {quote.data.roundedGrams} g chargeable</Small></Panel> : quote.isFetching ? <Small>Calculating applicable rate-card price…</Small> : quote.isError ? <Small color={colors.statusWarn}>{apiMessage(quote.error, "Rate-card price is unavailable until the destination and merchant tariff are complete.")}</Small> : <Small>Select a destination district to calculate the applicable rate-card price.</Small>}</Card>
      <Card><Title>Payment on delivery</Title><Input label="COD to collect (Rs.)" value={form.codAmount} onChangeText={set("codAmount")} keyboardType="decimal-pad" /><Choice label="Included delivery charge" selected={form.codIncludesDeliveryCharge} onPress={() => set("codIncludesDeliveryCharge")(!form.codIncludesDeliveryCharge)} /></Card>
    </>}
    <Modal visible={merchantPicker} transparent animationType="slide" onRequestClose={() => setMerchantPicker(false)}><Pressable style={styles.backdrop} onPress={() => setMerchantPicker(false)}><View style={[styles.sheet, { backgroundColor: colors.card }]}><Title>Select merchant</Title>{(merchants.data ?? []).map((merchant) => <Pressable key={merchant.id} onPress={() => setMerchant(merchant.id)} style={styles.merchantRow}><Body>{merchant.name}</Body><Small>{merchant.address || "Address not recorded"}</Small></Pressable>)}{merchants.isSuccess && merchants.data?.length === 0 ? <Empty title="No merchants available" detail="No merchant is visible in this hub scope." /> : null}</View></Pressable></Modal><BarcodeScanner visible={scanning} onClose={() => setScanning(false)} onScanned={(value) => { setScanning(false); set("awb")(value.trim().toUpperCase()); }} />
  </Screen>;
}
function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) { const colors = useColors(); return <Pressable onPress={onPress} style={[styles.choice, { borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primary : "transparent" }]}><Body color={selected ? colors.primaryForeground : colors.foreground}>{selected ? "✓ " : ""}{label}</Body></Pressable>; }
const styles = StyleSheet.create({ flex: { flex: 1 }, row: { flexDirection: "row", gap: Space.unit, flexWrap: "wrap" }, select: { minHeight: 50, borderWidth: 1, borderRadius: Space.radius, paddingHorizontal: Space.card, justifyContent: "center", marginBottom: Space.unit }, addressLine: { flexDirection: "row", alignItems: "center", gap: Space.unit, marginBottom: Space.unit }, choice: { minHeight: 44, borderWidth: 1, borderRadius: Space.radiusPill, paddingHorizontal: Space.card, justifyContent: "center" }, backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.55)", justifyContent: "flex-end" }, sheet: { maxHeight: "80%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: Space.page }, merchantRow: { paddingVertical: Space.unit, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#64748b" } });
