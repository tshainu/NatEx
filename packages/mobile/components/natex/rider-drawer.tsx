import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../lib/auth";
import { setThemePreference, useThemePreference } from "../../lib/theme";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Body, Small, Title } from "./text";

const MENU = [
  ["Home", "Return to your dashboard", "home-outline", "/(rider)/home"],
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

const HUB_MANAGER_MENU = [
  ["Book a parcel", "Native hub booking", "add-circle-outline", "/(transport)/book"],
  ["Ops", "Bags, transport, and inbound", "business-outline", "/(rider)/ops"],
] as const;

type RiderDrawerContextValue = { open: () => void };
const RiderDrawerContext = React.createContext<RiderDrawerContextValue | null>(null);

export function RiderDrawerProvider({ children }: { children: React.ReactNode }) {
  const { user, role, roles, signOut, switchRole } = useAuth();
  const [visible, setVisible] = React.useState(false);
  const value = React.useMemo(() => ({ open: () => setVisible(true) }), []);
  if (role !== "rider" && role !== "transport") return <>{children}</>;
  // Hub Manager accounts currently carry both the Rider and Transport field
  // roles. Do not expose these operational actions to a rider-only account.
  const isHubManager = roles.includes("rider") && roles.includes("transport");
  return <RiderDrawerContext.Provider value={value}>{children}<RiderDrawer visible={visible} onClose={() => setVisible(false)} userName={user?.name ?? "Rider"} branch={user?.branchName ?? "NatEx field team"} role={role} signOut={signOut} isHubManager={isHubManager} switchRole={switchRole} /></RiderDrawerContext.Provider>;
}

export function useRiderDrawer() { return React.useContext(RiderDrawerContext); }

function RiderDrawer({ visible, onClose, userName, branch, role, signOut, isHubManager, switchRole }: { visible: boolean; onClose: () => void; userName: string; branch: string; role: "rider" | "transport"; signOut: () => Promise<void>; isHubManager: boolean; switchRole: (role: "rider" | "transport") => Promise<void> }) {
  const colors = useColors();
  const preference = useThemePreference();
  const insets = useSafeAreaInsets();
  const safeBottom = Math.max(insets.bottom, Platform.OS === "android" ? 24 : 0);
  const openMenuRoute = async (href: (typeof MENU)[number][3]) => {
    onClose();
    if (role !== "rider") await switchRole("rider");
    router.push(href);
  };
  const openHubManagerRoute = async (href: (typeof HUB_MANAGER_MENU)[number][3]) => {
    onClose();
    if (role !== "transport") await switchRole("transport");
    router.push(href.replace("/(transport)/book", "/(transport)/book") as never);
  };
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><View style={styles.modalRoot}><Pressable style={styles.scrim} onPress={onClose} /><View style={[styles.drawer, { backgroundColor: colors.background, paddingBottom: safeBottom + Space.page }]}><ScrollView contentContainerStyle={styles.drawerContent} showsVerticalScrollIndicator={false}><View style={styles.drawerHandle} /><View style={styles.profile}><View style={[styles.avatar, { backgroundColor: colors.primary }]}><Body color={colors.primaryForeground}>{userName.slice(0, 1).toUpperCase()}</Body></View><View style={styles.flex}><Title>{userName}</Title><Small>{branch}</Small></View><Pressable accessibilityLabel="Close rider menu" onPress={onClose}><Ionicons name="close" size={23} color={colors.mutedForeground} /></Pressable></View><View style={[styles.divider, { backgroundColor: colors.border }]} />{MENU.map(([label, detail, icon, href]) => <Pressable key={label} onPress={() => void openMenuRoute(href)} style={styles.item}><Ionicons name={icon} size={20} color={colors.primary} /><View style={styles.flex}><Body>{label}</Body><Small>{detail}</Small></View><Ionicons name="chevron-forward" size={17} color={colors.mutedForeground} /></Pressable>)}{isHubManager ? <><View style={[styles.sectionLabel, { borderColor: colors.border }]}><Small color={colors.primary}>OPS</Small></View>{HUB_MANAGER_MENU.map(([label, detail, icon, href]) => <Pressable key={label} onPress={() => void openHubManagerRoute(href)} style={styles.item}><Ionicons name={icon} size={20} color={colors.primary} /><View style={styles.flex}><Body>{label}</Body><Small>{detail}</Small></View><Ionicons name="chevron-forward" size={17} color={colors.mutedForeground} /></Pressable>)}</> : null}<View style={styles.footer}><View style={styles.footerRow}><Pressable onPress={async () => { onClose(); await signOut(); router.replace("/login"); }} style={styles.footerAction}><Ionicons name="log-out-outline" size={18} color={colors.statusWarn} /><Small color={colors.statusWarn}>Sign out</Small></Pressable><View style={styles.themeRow}><Pressable onPress={() => void setThemePreference("dark")} style={[styles.themeChoice, { backgroundColor: preference === "dark" ? colors.primary : colors.secondary }]}><Ionicons name="moon-outline" size={15} color={preference === "dark" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "dark" ? colors.primaryForeground : colors.foreground}>Dark</Small></Pressable><Pressable onPress={() => void setThemePreference("day")} style={[styles.themeChoice, { backgroundColor: preference === "day" ? colors.primary : colors.secondary }]}><Ionicons name="sunny-outline" size={15} color={preference === "day" ? colors.primaryForeground : colors.mutedForeground} /><Small color={preference === "day" ? colors.primaryForeground : colors.foreground}>Light</Small></Pressable></View></View></View></ScrollView></View></View></Modal>;
}

const styles = StyleSheet.create({ flex: { flex: 1 }, modalRoot: { flex: 1, flexDirection: "row" }, scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.52)" }, drawer: { width: "86%", maxWidth: 360, paddingTop: Space.page, paddingHorizontal: Space.page, paddingBottom: Space.page, elevation: 20, shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 18 }, drawerContent: { flexGrow: 1 }, drawerHandle: { alignSelf: "center", width: 38, height: 4, borderRadius: 4, backgroundColor: "rgba(128,128,128,0.4)", marginBottom: Space.page }, profile: { flexDirection: "row", alignItems: "center", gap: Space.unit * 1.25 }, avatar: { width: 48, height: 48, borderRadius: 17, alignItems: "center", justifyContent: "center" }, divider: { height: StyleSheet.hairlineWidth, marginVertical: Space.unit * 1.25 }, sectionLabel: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: Space.unit, marginTop: Space.unit, marginBottom: Space.unit }, item: { minHeight: 47, flexDirection: "row", alignItems: "center", gap: Space.unit, paddingVertical: 5 }, footer: { marginTop: "auto", paddingTop: Space.unit * 2 }, footerRow: { flexDirection: "row", alignItems: "center", gap: Space.unit }, footerAction: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6 }, themeRow: { flexDirection: "row", gap: 6 }, themeChoice: { minWidth: 66, minHeight: 40, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 } });
