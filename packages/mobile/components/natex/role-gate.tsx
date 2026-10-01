import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "../../lib/auth";
import { homeRouteFor, type Role } from "../../lib/session";
import { Colors } from "../../constants/theme";

/**
 * Guards a role's tab group. The server enforces role on every procedure
 * (`riderProc`, `transportProc`) — this is only so a person never sees a tab
 * that would 403 the moment they touched it, which design.md states outright:
 * "Role decides the tab set: a rider never sees transport tabs and vice-versa."
 */
export function RoleGate({
  allow,
  children,
}: {
  allow: readonly Role[];
  children: React.ReactNode;
}) {
  const { ready, role } = useAuth();

  if (!ready) {
    return (
      <View style={[styles.splash, { backgroundColor: Colors.dark.background }]}>
        <ActivityIndicator color={Colors.dark.primary} />
      </View>
    );
  }

  if (!role) return <Redirect href="/login" />;
  if (!allow.includes(role)) return <Redirect href={homeRouteFor(role)} />;

  return <>{children}</>;
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center" },
});
