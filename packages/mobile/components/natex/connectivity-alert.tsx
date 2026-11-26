import React from "react";
import { StyleSheet, View } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useAuth } from "../../lib/auth";

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
      <View accessibilityLabel="No internet connection" style={[styles.alert, { backgroundColor: colors.statusWarn, borderColor: colors.card }]}>
        <Ionicons name="cloud-offline-outline" size={21} color={colors.card} />
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
    alignItems: "flex-end",
  },
  alert: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 999,
    width: 38,
    height: 38,
  },
});
