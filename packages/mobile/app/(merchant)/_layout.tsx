import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Colors, Space, Type } from "../../constants/theme";
import { ThemeOverrideProvider } from "../../hooks/use-colors";

/** Merchant workspace: light-only, thumb-friendly tabs, with task screens hidden from the bar. */
export default function MerchantLayout() {
  return (
    <ThemeOverrideProvider scheme="light">
      <RoleGate allow={["merchant"]}>
        <StatusBar style="dark" backgroundColor={Colors.light.background} />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: "#176B2C",
            tabBarInactiveTintColor: Colors.light.mutedForeground,
            tabBarStyle: {
              backgroundColor: Colors.light.card,
              borderTopColor: Colors.light.border,
              height: Space.minTouch + 26,
              paddingTop: 6,
            },
            tabBarLabelStyle: { fontFamily: Fonts.bodyMedium, fontSize: Type.label + 1 },
          }}
        >
          <Tabs.Screen
            name="index"
            options={{
              title: "Home",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "home" : "home-outline"} size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="shipments"
            options={{
              title: "Shipments",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "cube" : "cube-outline"} size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="book"
            options={{
              title: "Book",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "add-circle" : "add-circle-outline"} size={size + 3} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="pickups"
            options={{
              title: "Pickups",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "bicycle" : "bicycle-outline"} size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen
            name="more"
            options={{
              title: "More",
              tabBarIcon: ({ color, size, focused }) => (
                <Ionicons name={focused ? "menu" : "menu-outline"} size={size} color={color} />
              ),
            }}
          />
          <Tabs.Screen name="shipment/[awb]" options={{ href: null, tabBarStyle: { display: "none" } }} />
          <Tabs.Screen name="statement" options={{ href: null, tabBarStyle: { display: "none" } }} />
          <Tabs.Screen name="ndr" options={{ href: null, tabBarStyle: { display: "none" } }} />
        </Tabs>
      </RoleGate>
    </ThemeOverrideProvider>
  );
}
