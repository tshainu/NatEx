import React from "react";
import { StyleSheet, View } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useAuth } from "../../lib/auth";
import { Small } from "./text";

/** Remains visible for the entire outage and disappears only after connectivity returns. */
export function ConnectivityAlert() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { role } = useAuth();
  const [offline, setOffline] = React.useState(false);

  React.useEffect(() => {
    let mounted = true;
    const update = (state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
      if (!mounted) return;
      setOffline(state.isConnected === false || state.isInternetReachable === false);
    };

    void NetInfo.fetch().then(update);
    const unsubscribe = NetInfo.addEventListener(update);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (role !== "rider" || !offline) return null;

  return (
    <View pointerEvents="none" style={[styles.overlay, { top: insets.top + Space.unit }]}>
      <View style={[styles.alert, { backgroundColor: colors.statusWarn, borderColor: colors.card }]}>
        <Ionicons name="cloud-offline-outline" size={20} color={colors.card} />
        <Small style={styles.copy} color={colors.card}>
          No internet connection. Delivery updates are saved on this phone and will sync when internet is back.
        </Small>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: Space.page,
    right: Space.page,
    zIndex: 100,
    elevation: 100,
  },
  alert: {
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit,
    borderWidth: 1,
    borderRadius: Space.radius,
    paddingHorizontal: Space.unit * 1.5,
    paddingVertical: Space.unit * 1.25,
  },
  copy: { flex: 1 },
});
