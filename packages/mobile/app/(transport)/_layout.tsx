import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { RiderDrawerProvider } from "../../components/natex/rider-drawer";
import { AnimatedWaveTabBar } from "../../components/natex/animated-wave-tab-bar";
import { useColors } from "../../hooks/use-colors";

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

  return (
    <RoleGate allow={["transport"]}>
      <RiderDrawerProvider><Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedForeground,
        }}
        tabBar={(props) => <AnimatedWaveTabBar {...props} />}
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
            title: "Transport",
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
      </Tabs></RiderDrawerProvider>
    </RoleGate>
  );
}
