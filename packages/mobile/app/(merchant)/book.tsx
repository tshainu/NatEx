import { useRef, useState } from "react";
import { router } from "expo-router";
import { randomUUID } from "expo-crypto";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
import { Button } from "../../components/natex/button";
import { Card, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Awb, Body, Label, Small, Title } from "../../components/natex/text";
import { apiMessage, client, orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { parseRupeesToCents } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";

interface BookingForm {
  orderRef: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  cod: string;
  declared: string;
}

const INITIAL: BookingForm = {
  orderRef: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: "",
  weightKg: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  cod: "",
  declared: "",
};

function parseKilograms(raw: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;
  const grams = Number(match[1]) * 1000 + Number((match[2] ?? "").padEnd(3, "0"));
  return grams > 0 && grams <= 200_000 ? grams : null;
}

function parseOptionalCm(raw: string): number | null | false {
  if (!raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim())) return false;
  const cm = Number(raw.trim());
  return cm >= 1 && cm <= 500 ? cm : false;
}

export default function MerchantBook() {
  const colors = useColors();
  const queryClient = useQueryClient();
  const merchantId = useAuth().session?.user.merchantId;
  const profile = useQuery({
    ...orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 1 } }),
    select: (result) => result.rows[0] ?? null,
  });
  const [form, setForm] = useState(INITIAL);
  const [error, setError] = useState<string | null>(null);
  const [successAwb, setSuccessAwb] = useState<string | null>(null);
  const [booking, setBooking] = useState(false);
  const keyRef = useRef<string | null>(null);
  const codEnabled = profile.data?.codEnabled ?? true;
  const inactive = profile.data ? profile.data.status !== "active" : false;

  const set = (key: keyof BookingForm) => (value: string) => {
    keyRef.current = null;
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!merchantId) return setError("This login is not linked to a merchant account. Contact NatEx operations.");
    if (!form.consigneeName.trim() || form.consigneeName.trim().length < 2) return setError("Enter the consignee’s name.");
    if (form.consigneePhone.trim().length < 9) return setError("Enter a valid consignee phone number.");
    if (form.destAddress.trim().length < 8) return setError("Enter a full delivery address (at least 8 characters).");

    const weightGrams = parseKilograms(form.weightKg);
    if (weightGrams === null) return setError("Enter a parcel weight from 0.001 to 200 kg.");
    const dimensions = {
      lengthCm: parseOptionalCm(form.lengthCm),
      widthCm: parseOptionalCm(form.widthCm),
      heightCm: parseOptionalCm(form.heightCm),
    };
    if (Object.values(dimensions).some((value) => value === false)) return setError("Dimensions must be whole centimetres from 1 to 500.");

    const cod = form.cod.trim() ? parseRupeesToCents(form.cod) : 0;
    const declared = form.declared.trim() ? parseRupeesToCents(form.declared) : 0;
    if (cod === null || declared === null) return setError("Enter money amounts in rupees with up to two decimal places.");
    if (!codEnabled && cod > 0) return setError("COD is not enabled on your merchant account. Book this as prepaid.");

    keyRef.current ??= randomUUID();
    setBooking(true);
    try {
      const response = await client.parcels.bulkCreate(
        {
          merchantId,
          dryRun: false,
          rows: [{
            line: 1,
            orderRef: form.orderRef.trim() || null,
            consigneeName: form.consigneeName.trim(),
            consigneePhone: form.consigneePhone.trim(),
            destAddress: form.destAddress.trim(),
            weightGrams,
            lengthCm: dimensions.lengthCm === false ? null : dimensions.lengthCm,
            widthCm: dimensions.widthCm === false ? null : dimensions.widthCm,
            heightCm: dimensions.heightCm === false ? null : dimensions.heightCm,
            codAmountCents: cod,
            declaredValueCents: declared,
          }],
        },
        { context: { idempotencyKey: keyRef.current } },
      );
      const booked = response.accepted[0];
      if (booked?.awb) {
        setSuccessAwb(booked.awb);
        keyRef.current = null;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.parcels.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.merchants.key() }),
        ]);
      } else {
        const messages = response.rejected[0]?.errors?.map((item) => item.message) ?? [];
        setError(messages.length ? messages.join(" · ") : "The parcel could not be booked. Check the details and try again.");
        keyRef.current = null;
      }
    } catch (cause) {
      // Retain this key for a retry of the same intent so a network retry cannot double-book.
      setError(apiMessage(cause, "The booking could not be confirmed. Retry safely or check Shipments before submitting again."));
    } finally {
      setBooking(false);
    }
  };

  return (
    <Screen
      inTabs
      footer={successAwb ? (
        <Button title="Book another parcel" onPress={() => { setSuccessAwb(null); setForm(INITIAL); }} />
      ) : (
        <Button title="Create booking" loading={booking} disabled={inactive || booking} onPress={() => { void submit(); }} hint={inactive ? "Contact NatEx operations to reactivate your account." : undefined} />
      )}
    >
      <ScreenHeader title="Book a shipment" subtitle="Enter the delivery details. Your pickup address is already on file." />

      {profile.data?.address ? (
        <Panel>
          <Label>PICKUP FROM</Label>
          <Body>{profile.data.address}</Body>
          <Small>To update this address, contact your NatEx account manager.</Small>
        </Panel>
      ) : null}
      {profile.data?.status && profile.data.status !== "active" ? (
        <Panel style={{ borderColor: colors.statusWarn }}>
          <Title color={colors.statusWarn}>Account {profile.data.status}</Title>
          <Small>New bookings are disabled until NatEx operations reactivates the account.</Small>
        </Panel>
      ) : null}

      {error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{error}</Body></Panel> : null}

      {successAwb ? (
        <Card style={styles.successCard}>
          <View style={styles.successIcon}><Title color="#176B2C">✓</Title></View>
          <Title>Shipment booked</Title>
          <Small>Share this AWB with your team and include it in the next pickup request.</Small>
          <Awb color="#176B2C" style={styles.successAwb}>{successAwb}</Awb>
          <Button title="Track this shipment" variant="secondary" onPress={() => router.push({ pathname: "/(merchant)/shipment/[awb]", params: { awb: successAwb } })} />
        </Card>
      ) : (
        <>
          <Card>
            <Title>Consignee</Title>
            <Input label="Full name" value={form.consigneeName} onChangeText={set("consigneeName")} autoCapitalize="words" returnKeyType="next" placeholder="Recipient name" />
            <Input label="Phone number" value={form.consigneePhone} onChangeText={set("consigneePhone")} keyboardType="phone-pad" placeholder="077 123 4567" />
            <Input label="Delivery address" value={form.destAddress} onChangeText={set("destAddress")} multiline numberOfLines={3} textAlignVertical="top" placeholder="House, street, town and nearest landmark" />
            <Input label="Order reference (optional)" value={form.orderRef} onChangeText={set("orderRef")} autoCapitalize="characters" placeholder="Your internal order ID" />
          </Card>

          <Card>
            <Title>Parcel details</Title>
            <Input label="Weight (kg)" value={form.weightKg} onChangeText={set("weightKg")} keyboardType="decimal-pad" placeholder="e.g. 1.25" hint="From 0.001 to 200 kg" />
            <View style={styles.dimensionRow}>
              <Input label="Length (cm)" value={form.lengthCm} onChangeText={set("lengthCm")} keyboardType="number-pad" placeholder="Optional" />
              <Input label="Width (cm)" value={form.widthCm} onChangeText={set("widthCm")} keyboardType="number-pad" placeholder="Optional" />
              <Input label="Height (cm)" value={form.heightCm} onChangeText={set("heightCm")} keyboardType="number-pad" placeholder="Optional" />
            </View>
            <Input label="Declared value (Rs.)" value={form.declared} onChangeText={set("declared")} keyboardType="decimal-pad" placeholder="0.00" hint="Optional, for shipment records" />
          </Card>

          <Card>
            <Title>Payment on delivery</Title>
            {codEnabled ? (
              <Input label="COD to collect (Rs.)" value={form.cod} onChangeText={set("cod")} keyboardType="decimal-pad" placeholder="Leave blank for prepaid" hint="Leave blank or enter 0 for a prepaid order." />
            ) : (
              <Panel><Small>COD is not enabled for your account. This parcel will be prepaid.</Small></Panel>
            )}
          </Card>
          <Small>AWBs are assigned by NatEx when the booking is accepted. You can request a rider pickup after booking.</Small>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  successCard: { alignItems: "center", paddingVertical: 22 },
  successIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: "#E8F5E9", alignItems: "center", justifyContent: "center" },
  successAwb: { fontSize: 24, marginVertical: 8 },
  dimensionRow: { flexDirection: "row", gap: Space.unit },
});
