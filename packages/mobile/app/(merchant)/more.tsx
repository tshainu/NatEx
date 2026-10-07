import { useState } from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../components/natex/button";
import { Card, Empty, Panel } from "../../components/natex/card";
import { Screen, ScreenHeader } from "../../components/natex/screen";
import { Body, Label, Small, Title } from "../../components/natex/text";
import { orpc } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { date } from "../../lib/format";
import { useColors } from "../../hooks/use-colors";

export default function MerchantMore() {
  const colors = useColors();
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const profile = useQuery({
    ...orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 1 } }),
    staleTime: 5 * 60_000,
    select: (result) => result.rows[0] ?? null,
  });
  const merchant = profile.data;

  const logout = async () => {
    setSigningOut(true);
    try {
      await signOut();
      router.replace("/login");
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Screen inTabs onRefresh={() => { void profile.refetch(); }} refreshing={profile.isRefetching}>
      <View style={styles.brandWrap}>
        <Image source={require("../../assets/natex-wordmark.jpg")} style={styles.wordmark} resizeMode="contain" accessibilityLabel="NatEx" />
      </View>
      <ScreenHeader title="Your account" subtitle="Merchant information and financial tools." />

      {merchant ? (
        <Card>
          <View style={styles.accountTitle}>
            <View style={styles.avatar}><Title color="#176B2C">{(merchant.name || "N").trim().slice(0, 1).toUpperCase()}</Title></View>
            <View style={styles.flex}>
              <Title>{merchant.name}</Title>
              <Small>Contact: {merchant.contactName}</Small>
            </View>
            <View style={[styles.statusPill, { backgroundColor: merchant.status === "active" ? "#E7F5EC" : "#FFF1F0" }]}>
              <Small color={merchant.status === "active" ? "#176B2C" : colors.statusWarn}>{merchant.status === "active" ? "Active" : "Suspended"}</Small>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <AccountField label="Signed-in user" value={user?.name ?? "—"} />
          <AccountField label="Contact phone" value={merchant.contactPhone} />
          {merchant.vatNo ? <AccountField label="VAT number" value={merchant.vatNo} /> : null}
          <AccountField label="Pickup address" value={merchant.address} />
          <View style={styles.twoCol}>
            <AccountField label="Cash on delivery" value={merchant.codEnabled ? "Enabled" : "Prepaid only"} />
            <AccountField label="Proof of delivery" value={merchant.podPolicy} />
          </View>
          <Small>On file since {date(merchant.createdAt)}</Small>
        </Card>
      ) : profile.isLoading ? (
        <Panel><Small>Loading account…</Small></Panel>
      ) : (
        <Empty title="Merchant account not found" detail="Ask NatEx operations to link your login to a merchant account." />
      )}

      <Label>BUSINESS TOOLS</Label>
      <ActionRow
        icon="wallet-outline"
        title="COD & settlements"
        subtitle="Payable balance, payouts, holds and bank details"
        onPress={() => router.push("/(merchant)/statement")}
      />
      <ActionRow
        icon="alert-circle-outline"
        title="Failed deliveries & returns"
        subtitle="Review NDRs and send delivery instructions"
        onPress={() => router.push("/(merchant)/ndr")}
      />
      <ActionRow
        icon="bicycle-outline"
        title="Pickup requests"
        subtitle="Review requested and scheduled collections"
        onPress={() => router.push("/(merchant)/pickups")}
      />

      <Panel>
        <Label>NEED AN ACCOUNT CHANGE?</Label>
        <Small>Pickup address, COD eligibility and proof-of-delivery policy are managed by NatEx operations. Contact your account manager to update them.</Small>
      </Panel>
      <Button title="Sign out" variant="secondary" loading={signingOut} onPress={() => { void logout(); }} />
    </Screen>
  );
}

function AccountField({ label, value }: { label: string; value: string }) {
  return <View style={styles.field}><Label>{label}</Label><Body>{value || "—"}</Body></View>;
}

function ActionRow({ icon, title, subtitle, onPress }: { icon: keyof typeof Ionicons.glyphMap; title: string; subtitle: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.actionRow, { borderColor: colors.border, backgroundColor: colors.card, opacity: pressed ? 0.85 : 1 }]}>
      <View style={styles.actionIcon}><Ionicons name={icon} size={22} color="#176B2C" /></View>
      <View style={styles.flex}><Title style={styles.actionTitle}>{title}</Title><Small>{subtitle}</Small></View>
      <Ionicons name="chevron-forward" size={20} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  brandWrap: { alignItems: "center", marginTop: 2, marginBottom: 2 },
  wordmark: { width: 124, height: 40 },
  accountTitle: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "#E7F5EC" },
  statusPill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  field: { gap: 4, marginBottom: 4 },
  twoCol: { flexDirection: "row", gap: 16 },
  actionRow: { minHeight: 76, borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  actionIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "#EEF8F0", alignItems: "center", justifyContent: "center" },
  actionTitle: { fontSize: 16 },
});
