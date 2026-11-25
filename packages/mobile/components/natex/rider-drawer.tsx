import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useAuth } from "../../lib/auth";
import { setThemePreference, useThemePreference } from "../../lib/theme";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Body, Small, Title } from "./text";

const MENU = [
  ["Delivery", "Today’s active route", "bicycle-outline", "/(rider)/deliveries"],
  ["Pick-up", "Merchant collection list", "cube-outline", "/(rider)"],
  ["Transport", "Active linehaul and run details", "navigate-outline", "/(rider)/transport"],
  ["Over-time earning", "Monthly approved overtime", "cash-outline", "/(rider)/overtime"],
  ["Leave management", "Balances and leave requests", "calendar-outline", "/(rider)/leave"],
  ["Running chart", "View your GPS route", "map-outline", "/(rider)/route"],
  ["Enrol New Merchant", "Submit a new merchant", "storefront-outline", "/(rider)/enroll-merchant"],
  ["Delivery history", "Completed deliveries", "time-outline", "/(rider)/delivered"],
  ["Failed attempts", "Review NDRs and reattempts", "alert-circle-outline", "/(rider)/failed-attempts"],
] as const;

type RiderDrawerContextValue = { open: () => void };
const RiderDrawerContext = React.createContext<RiderDrawerContextValue | null>(null);

export function RiderDrawerProvider({ children }: { children: React.ReactNode }) {
  const { user, role, signOut } = useAuth();
  const [visible, setVisible] = React.useState(false);
  const value = React.useMemo(() => ({ open: () => setVisible(true) }), []);
  if (role !== "rider") return <>{children}</>;
  return <RiderDrawerContext.Provider value={value}>{children}<RiderDrawer visible={visible} onClose={() => setVisible(false)} userName={user?.name ?? "Rider"} branch={user?.branchName ?? "NatEx field team"} signOut={signOut} /></RiderDrawerContext.Provider>;
}

export function useRiderDrawer() { return React.useContext(RiderDrawerContext); }

function RiderDrawer({ visible, onClose, userName, branch, signOut }: { visible: boolean; onClose: () => void; userName: string; branch: string; signOut: () => Promise<void> }) {
  const colors = useColors();
  const preference = useThemePreference();
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalRoot}><Pressable style={styles.scrim} onPress={onClose} /><View style={[styles.drawer, { backgroundColor: colors.background }]}><ScrollView contentContainerStyle={styles.drawerContent} showsVerticalScrollIndicator={false}><View style={styles.drawerHandle} /><View style={styles.profile}><View style={[styles.avatar, { backgroundColor: colors.primary }]}><Body color={colors.primaryForeground}>{userName.slice(0, 1).toUpperCase()}</Body></View><View style={styles.flex}><Title>{userName}</Title><Small>{branch}</Small></View><Pressable accessibilityLabel="Close rider menu" onPress={onClose}><Ionicons name="close" size={23} color={colors.mutedForeground} /></Pressable></View><View style={[styles.divider, { backgroundColor: colors.border }]} />{MENU.map(([label, detail, icon, href]) => <Pressable key={label} onPress={() => { onClose(); router.push(href); }} style={styles.item}><Ionicons name={icon} size={20} color={colors.primary} /><View style={styles.flex}><Body>{label}</Body><Small>{detail}</Small></View><Ionicons name="chevron-forward" size={17} color={colors.mutedForeground} /></Pressable>)}<View style={styles.footer}><View style={styles.footerRow}><Pressable onPress={async () => { onClose(); await signOut(); router.replace("/login"); }} style={styles.footerAction}><Ionicons name="log-out-outline" size={18} color={colors.statusWarn} /><Small color={colors.statusWarn}>Sign out</Small></Pressable><View style={styles.themeRow}><Pressable onPress={() => void setThemePreference("dark")} style={[styles.themeChoice, { backgroundColor: preference === "dark" ? colors.primary : colors.secondary }]}><Ionicons name="moon-outline" size={15} color={preference === "dark" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "dark" ? colors.primaryForeground : colors.foreground}>Dark</Small></Pressable><Pressable onPress={() => void setThemePreference("day")} style={[styles.themeChoice, { backgroundColor: preference === "day" ? colors.primary : colors.secondary }]}><Ionicons name="sunny-outline" size={15} color={preference === "day" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "day" ? colors.primaryForeground : colors.foreground}>Light</Small></Pressable></View></View></View></ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({ flex: { flex: 1 }, modalRoot: { flex: 1, flexDirection: "row" }, scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.52)" }, drawer: { width: "86%", maxWidth: 360, paddingTop: Space.page, paddingHorizontal: Space.page, paddingBottom: Space.page, elevation: 20, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 18 }, drawerContent: { flexGrow: 1 }, drawerHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 4, backgroundColor: "rgba(128,128,128,0.4)", marginBottom: Space.page }, profile: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.25 }, avatar: { width: 48, height: 48, borderRadius: 17, alignItems: "center", justifyContent: "center" }, divider: { height: StyleSheet.hairlineWidth, marginVertical: Space.unit * 1.25 }, item: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: Space.unit, paddingVertical: 5 }, footer: { marginTop: "auto", paddingTop: Space.unit * 2 }, footerRow: { flexDirection: "row", alignItems: "center", gap: Space.unit }, footerAction: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6 }, themeRow: { flexDirection: "row", gap: 6 }, themeChoice: { minWidth: 66, minHeight: 40, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 } });
