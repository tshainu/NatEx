import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Space, Type } from "../../constants/theme";
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
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.mutedForeground,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            height: Space.minTouch + 26,
            paddingTop: 6,
          },
          tabBarLabelStyle: { fontFamily: Fonts.bodyMedium, fontSize: Type.label + 1 },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Bags",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "bag" : "bag-outline"} size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="trips"
          options={{
            title: "Trips",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "bus" : "bus-outline"} size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="inbound"
          options={{
            title: "Inbound",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? "download" : "download-outline"}
                size={size}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="me"
          options={{
            title: "Me",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "person" : "person-outline"} size={size} color={color} />
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
