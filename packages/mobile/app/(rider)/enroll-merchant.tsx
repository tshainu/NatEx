import { useState } from "react";
import { router } from "expo-router";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useMutation } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Panel } from "../../components/natex/card";
import { Input } from "../../components/natex/input";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { apiMessage, orpc } from "../../lib/api";
import { useColors } from "../../hooks/use-colors";
import { DISTRICTS_BY_PROVINCE } from "../../components/natex/address-fields";

const DISTRICTS = Object.values(DISTRICTS_BY_PROVINCE).flat();
const TYPES = ["Online", "retails", "wholesale", "others"];
const VOLUMES = ["Under 50", "50-200", "200-500", "500-1000", "Above 1000"];
const BANKS = ["Bank of Ceylon", "People’s Bank", "Commercial Bank", "Sampath Bank", "Hatton National Bank", "Other"];
const BRANCHES = ["Colombo", "Jaffna", "Kandy", "Galle", "Vavuniya", "Other"];

export default function EnrollMerchantScreen() {
  const colors = useColors();
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [district, setDistrict] = useState("");
  const [businessType, setBusinessType] = useState("Online");
  const [volume, setVolume] = useState("Under 50");
  const [account, setAccount] = useState("");
  const [bank, setBank] = useState("");
  const [branch, setBranch] = useState("");
  const [picker, setPicker] = useState<{ title: string; options: readonly string[]; value: string; onChange: (value: string) => void } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const clearForm = () => {
    setBusinessName("");
    setBusinessPhone("");
    setContactName("");
    setPhone("");
    setEmail("");
    setDistrict("");
    setBusinessType("Online");
    setVolume("Under 50");
    setAccount("");
    setBank("");
    setBranch("");
  };
  const enrollment = useMutation({
    ...orpc.merchants.riderEnrollMerchant.mutationOptions(),
    onSuccess: () => {
      clearForm();
      setMessage("Merchant enrollment request sent to NOS for approval. You can add another merchant now.");
    },
  });
  const canSubmit = businessName.trim().length >= 2 && businessPhone.trim().length >= 9 && contactName.trim().length >= 2 && phone.trim().length >= 9 && district.trim().length >= 2;
  const submit = () => enrollment.mutate({ name: businessName, contactName, contactPhone: phone, address: district, vatNo: account || null, codEnabled: true, podPolicy: "signature" });

  return <Screen footer={<View style={styles.actions}><Button title="Submit" loading={enrollment.isPending} disabled={!canSubmit} onPress={submit} style={styles.action} /><Button title="Cancel" variant="secondary" onPress={() => router.back()} style={styles.action} /></View>}>
    <ScreenHeader title="Enrol New Merchant" subtitle="Capture the business details for NOS approval." />
    <Card style={{ ...styles.hero, backgroundColor: colors.primary }}><View style={styles.heroIcon}><Ionicons name="storefront-outline" size={20} color={colors.primaryForeground} /></View><View style={styles.heroCopy}><Title color={colors.primaryForeground}>Grow your route</Title><Small color="#E8F6EC">A compact application for new merchant leads.</Small></View></Card>
    {enrollment.error ? <Panel style={{ borderColor: colors.statusWarn }}><Body color={colors.statusWarn}>{apiMessage(enrollment.error, "Could not submit this enrollment.")}</Body></Panel> : null}
    {message ? <Panel style={{ borderColor: colors.primary }}><Body color={colors.primary}>{message}</Body></Panel> : null}
    <Label>BUSINESS DETAILS</Label>
    <Input label="Business name *" value={businessName} onChangeText={setBusinessName} />
    <Input label="Business contact number *" value={businessPhone} onChangeText={setBusinessPhone} keyboardType="phone-pad" />
    <Input label="Contact person *" value={contactName} onChangeText={setContactName} />
    <Input label="Phone number *" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
    <Input label="Email address (optional)" value={email} onChangeText={setEmail} keyboardType="email-address" />
    <ChoiceField label="Business district *" value={district} placeholder="Select district" onPress={() => setPicker({ title: "Choose business district", options: DISTRICTS, value: district, onChange: setDistrict })} />
    <ChoiceField label="Business type" value={businessType} onPress={() => setPicker({ title: "Choose business type", options: TYPES, value: businessType, onChange: setBusinessType })} />
    <ChoiceField label="Estimated parcels per month" value={volume} onPress={() => setPicker({ title: "Choose monthly volume", options: VOLUMES, value: volume, onChange: setVolume })} />
    <Input label="Business account number (optional)" value={account} onChangeText={setAccount} />
    <ChoiceField label="Bank (optional)" value={bank} placeholder="Select bank" onPress={() => setPicker({ title: "Choose bank", options: BANKS, value: bank, onChange: setBank })} />
    <ChoiceField label="Branch (optional)" value={branch} placeholder="Select branch" onPress={() => setPicker({ title: "Choose branch", options: BRANCHES, value: branch, onChange: setBranch })} />
    <Small>SMS confirmation uses the contact person’s phone. The enrolling rider is recorded by the existing NOS approval and commission workflow.</Small>
    <Modal visible={Boolean(picker)} transparent animationType="fade" onRequestClose={() => setPicker(null)}><Pressable style={styles.backdrop} onPress={() => setPicker(null)}><Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={(event) => event.stopPropagation()}><View style={styles.sheetHeader}><Title>{picker?.title}</Title><Pressable onPress={() => setPicker(null)}><Ionicons name="close" size={22} color={colors.foreground} /></Pressable></View><FlatList data={picker?.options ?? []} keyExtractor={(item) => item} renderItem={({ item }) => <Pressable style={[styles.option, { borderBottomColor: colors.border }]} onPress={() => { picker?.onChange(item); setPicker(null); }}><Body>{item}</Body>{picker?.value === item ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}</Pressable>} /></Pressable></Pressable></Modal>
  </Screen>;
}

function ChoiceField({ label, value, placeholder = "Select", onPress }: { label: string; value: string; placeholder?: string; onPress: () => void }) {
  const colors = useColors();
  return <View style={styles.choiceWrap}><Label>{label}</Label><Pressable accessibilityRole="button" onPress={onPress} style={[styles.choice, { backgroundColor: colors.surface, borderColor: colors.border }]}><Body style={styles.choiceText}>{value || placeholder}</Body><Ionicons name="chevron-down" size={17} color={colors.mutedForeground} /></Pressable></View>;
}

const styles = StyleSheet.create({
  hero: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderWidth: 0 },
  heroIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  heroCopy: { flex: 1, gap: 2 },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1 },
  choiceWrap: { gap: 6 },
  choice: { minHeight: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 8 },
  choiceText: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end", padding: 16 },
  sheet: { maxHeight: "76%", borderWidth: 1, borderRadius: 18, padding: 14 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 10 },
  option: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth },
});
