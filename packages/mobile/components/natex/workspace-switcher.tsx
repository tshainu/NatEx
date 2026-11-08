import React from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../../lib/auth";
import { apiMessage, orpc } from "../../lib/api";
import { homeRouteFor, type MobileFieldRole } from "../../lib/session";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { Body, Small, Title } from "./text";

const WORKSPACES: {
  role: MobileFieldRole;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { role: "rider", title: "Rider", description: "Pickups, deliveries and hand-in", icon: "bicycle-outline" },
  { role: "transport", title: "Transport", description: "Bags, linehaul trips and inbound", icon: "bus-outline" },
];

/** Appears inline in the shared screen header when a user has multiple field roles. */
export function WorkspaceSwitcher() {
  return <WorkspaceMenu />;
}

function WorkspaceMenu() {
  const colors = useColors();
  const { user, role, session, switchRole } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  const isFieldSession =
    session?.scope?.kind === "mobile" &&
    (session.scope.role === "rider" || session.scope.role === "transport");
  const workspacesQuery = useQuery({
    ...orpc.identity.mobileWorkspaces.queryOptions(),
    enabled: isFieldSession,
    staleTime: 30_000,
  });
  const assignedRoles = workspacesQuery.data?.roles ?? session?.availableMobileRoles ?? [];
  const available = WORKSPACES.filter((workspace) => assignedRoles.includes(workspace.role));

  if (!isFieldSession || available.length < 2) return null;

  async function choose(nextRole: MobileFieldRole) {
    if (nextRole === role || switching) {
      setOpen(false);
      return;
    }
    setSwitching(true);
    setSwitchError(null);
    try {
      await switchRole(nextRole);
      setOpen(false);
      router.replace(homeRouteFor(nextRole));
    } catch (error) {
      setSwitchError(apiMessage(error, "This workspace could not be opened. Try again."));
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open workspaces menu"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons name="menu-outline" size={22} color={colors.foreground} />
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.overlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close workspaces menu"
            onPress={() => setOpen(false)}
            style={[StyleSheet.absoluteFill, styles.backdrop]}
          />
          <SafeAreaView
            edges={["top", "bottom", "left"]}
            style={[styles.drawer, { backgroundColor: colors.background, borderRightColor: colors.border }]}
          >
            <View style={[styles.brand, { borderBottomColor: colors.border }]}>
              <View style={styles.brandLine}>
                <Ionicons name="apps-outline" size={21} color={colors.primary} />
                <Title>NX Official</Title>
              </View>
              {user?.name ? <Small>{user.name}</Small> : null}
              <Small color={colors.mutedForeground}>Choose a workspace</Small>
            </View>
            <View style={styles.options}>
              {available.map((workspace) => {
                const selected = role === workspace.role;
                return (
                  <Pressable
                    key={workspace.role}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: switching }}
                    disabled={switching}
                    onPress={() => void choose(workspace.role)}
                    style={({ pressed }) => [
                      styles.option,
                      {
                        backgroundColor: selected ? colors.secondary : colors.card,
                        borderColor: selected ? colors.primary : colors.border,
                        opacity: pressed || switching ? 0.75 : 1,
                      },
                    ]}
                  >
                    <Ionicons
                      name={workspace.icon}
                      size={21}
                      color={selected ? colors.primary : colors.mutedForeground}
                    />
                    <View style={styles.optionText}>
                      <Body>{workspace.title}</Body>
                      <Small>{workspace.description}</Small>
                    </View>
                    {selected ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
                  </Pressable>
                );
              })}
              {switchError ? <Small color={colors.destructive}>{switchError}</Small> : null}
            </View>
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: "row" },
  backdrop: { backgroundColor: "rgba(0,0,0,0.48)" },
  drawer: {
    width: 320,
    maxWidth: "88%",
    flex: 1,
    borderRightWidth: StyleSheet.hairlineWidth,
    padding: Space.page,
    gap: Space.page,
    elevation: 12,
  },
  brand: { paddingBottom: Space.page, borderBottomWidth: StyleSheet.hairlineWidth, gap: 5 },
  brandLine: { flexDirection: "row", alignItems: "center", gap: Space.unit },
  options: { gap: Space.unit },
  option: {
    minHeight: 66,
    borderWidth: 1,
    borderRadius: Space.radius,
    paddingHorizontal: Space.card,
    paddingVertical: Space.unit,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit,
  },
  optionText: { flex: 1, gap: 2 },
  trigger: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderRadius: Space.radius,
    alignItems: "center",
    justifyContent: "center",
  },
});
