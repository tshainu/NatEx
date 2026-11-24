import { useState } from "react";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { apiMessage, orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";

export default function EnrollMerchantScreen() {
  const colors = useColors();
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [address, setAddress] = useState("");
  const [vatNo, setVatNo] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const enrollment = useMutation({
    ...orpc.merchants.riderEnrollMerchant.mutationOptions(),
    onSuccess: () => {
      setMessage("Merchant sent to NOS for approval. You will receive commission credit after approval.");
      setName(""); setContactName(""); setContactPhone(""); setAddress(""); setVatNo("");
    },
  });
  const canSubmit = name.trim().length >= 2 && contactName.trim().length >= 2 && contactPhone.trim().length >= 9 && address.trim().length >= 4;
  return (
    <Screen footer={<Button title="Submit for NOS approval" loading={enrollment.isPending} disabled={!canSubmit} onPress={() => enrollment.mutate({ name, contactName, contactPhone, address, vatNo: vatNo || null, codEnabled: true, podPolicy: "signature" })} />}>
      <ScreenHeader title="Enroll a merchant" subtitle="Introduce a business in your branch to NatEx." />
      <Card style={{ ...styles.hero, backgroundColor: colors.primary }}>
        <View style={styles.heroIcon}><Ionicons name="storefront-outline" size={22} color={colors.primaryForeground} /></View>
        <Title color={colors.primaryForeground}>Grow your route</Title>
        <Small color="#E8F6EC">Every approved merchant earns a Rs. 1,500 commission. NOS reviews every submission before activation.</Small>
      </Card>
      {enrollment.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(enrollment.error, "Could not submit this enrollment.")}</Body></Panel> : null}
      {message ? <Panel style={{ borderColor: colors.primary }}><Body color={colors.primary}>{message}</Body></Panel> : null}
      <Label>BUSINESS DETAILS</Label>
      <Input label="Business name" value={name} onChangeText={setName} placeholder="e.g. Jaffna Fashion House" autoCapitalize="words" />
      <Input label="Pickup address" value={address} onChangeText={setAddress} placeholder="Street, town, district" multiline />
      <Input label="VAT number (optional)" value={vatNo} onChangeText={setVatNo} autoCapitalize="characters" />
      <Label>CONTACT PERSON</Label>
      <Input label="Contact name" value={contactName} onChangeText={setContactName} autoCapitalize="words" />
      <Input label="Contact phone" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" />
      <Small>Submitted requests stay pending until NOS approves them. The enrolling rider is recorded on the request and commission report.</Small>
      <Button title="Cancel" variant="secondary" onPress={() => router.back()} />
    </Screen>
  );
}

const styles = StyleSheet.create({ hero: { gap: 8, borderWidth: 0, marginBottom: 4 }, heroIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" } });
