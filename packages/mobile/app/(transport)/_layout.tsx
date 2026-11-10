import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Platform } from "react-native";

/**
 * The transport clerk's four tabs.
 *
 * §7 splits hub work into two halves that happen at opposite ends of a
 * linehaul: sending (bag, seal, load, depart) and receiving (scan against the
 * manifest, record variance). The same person never does both for the same bag,
 * so Bags/Trips and Inbound are separate tabs rather than one merged queue.
 */
export default function TransportLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 12);

  return (
    <RoleGate allow={["transport"]}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedForeground,
          tabBarStyle: {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: Space.minTouch + 24 + bottomInset,
            paddingTop: 8,
            paddingBottom: bottomInset,
            ...Platform.select({
              web: { boxShadow: "0px -4px 14px rgba(0,0,0,0.12)" },
              default: {
                elevation: 12,
                shadowColor: "#000000",
                shadowOffset: { width: 0, height: -4 },
                shadowOpacity: 0.12,
                shadowRadius: 14,
              },
            }),
          },
          tabBarLabelStyle: { fontFamily: Fonts.bodyMedium, fontSize: Type.label + 1, marginTop: 2 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Bags",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "bag" : "bag-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: "Trips",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "bus" : "bus-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="inbound"
          options={{
            title: "Inbound",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "download" : "download-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "settings" : "settings-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        {/* Detail screens — pushed from a card, never in the tab bar. */}
        <Tabs.Screen name="bag/[id]" options={{ href: null }} />
        <Tabs.Screen name="trip/[id]" options={{ href: null }} />
        <Tabs.Screen name="receive/[id]" options={{ href: null }} />
      </Tabs>
    </RoleGate>
  );
}
