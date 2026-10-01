import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";
import { homeRouteFor } from "../lib/session";
import { Colors } from "../constants/theme";

/**
 * Launch gate. Nothing decides where the app opens except the role on the
 * persisted session: design.md, "Role decides the tab set: a rider never sees
 * transport tabs and vice-versa."
 *
 * While the keychain read is in flight this renders the ink shell rather than
 * the login screen, so a rider reopening the app mid-shift never sees a
 * sign-in flash before their manifests appear.
 */
export default function Index() {
  const { ready, role } = useAuth();

  if (!ready) {
    return (
      <View style={[styles.splash, { backgroundColor: Colors.dark.background }]}>
        <ActivityIndicator color={Colors.dark.primary} />
      </View>
    );
  }

  return <Redirect href={homeRouteFor(role ?? undefined)} />;
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: "center", justifyContent: "center" },
});
