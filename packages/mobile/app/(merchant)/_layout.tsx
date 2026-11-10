import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { StatusBar } from "expo-status-bar";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Colors, Space, Type } from "../../constants/theme";
import { ThemeOverrideProvider } from "../../hooks/use-colors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Platform } from "react-native";

/** Merchant workspace: light-only, thumb-friendly tabs, with task screens hidden from the bar. */
export default function MerchantLayout() {
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 12);
  return (
    <ThemeOverrideProvider scheme="light">
      <RoleGate allow={["merchant"]}>
        <StatusBar style="dark" />
        <Tabs
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: Colors.light.primary,
            tabBarInactiveTintColor: Colors.light.mutedForeground,
            tabBarStyle: {
              backgroundColor: Colors.light.card,
              borderTopColor: Colors.light.border,
              borderTopWidth: 1,
              height: Space.minTouch + 24 + bottomInset,
              paddingTop: 8,
              paddingBottom: bottomInset,
              ...Platform.select({
                web: { boxShadow: "0px -4px 14px rgba(0,0,0,0.1)" },
                default: {
                  elevation: 12,
                  shadowColor: "#000000",
                  shadowOffset: { width: 0, height: -4 },
                  shadowOpacity: 0.1,
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
              title: "Home",
              tabBarIcon: ({ size, focused }) => (
                <Ionicons
                  name={focused ? "home" : "home-outline"}
                  size={size}
                  color={focused ? Colors.light.primary : Colors.light.mutedForeground}
                />
              ),
            }}
          />
          <Tabs.Screen
            name="shipments"
            options={{
              title: "Shipments",
              tabBarIcon: ({ size, focused }) => (
                <Ionicons
                  name={focused ? "cube" : "cube-outline"}
                  size={size}
                  color={focused ? Colors.light.primary : Colors.light.mutedForeground}
                />
              ),
            }}
          />
          <Tabs.Screen
            name="book"
            options={{
              title: "Book",
              tabBarIcon: ({ size, focused }) => (
                <Ionicons
                  name={focused ? "add-circle" : "add-circle-outline"}
                  size={size + 3}
                  color={focused ? Colors.light.primary : Colors.light.mutedForeground}
                />
              ),
            }}
          />
          <Tabs.Screen
            name="pickups"
            options={{
              title: "Pickups",
              tabBarIcon: ({ size, focused }) => (
                <Ionicons
                  name={focused ? "bicycle" : "bicycle-outline"}
                  size={size}
                  color={focused ? Colors.light.primary : Colors.light.mutedForeground}
                />
              ),
            }}
          />
          <Tabs.Screen
            name="more"
            options={{
              title: "More",
              tabBarIcon: ({ size, focused }) => (
                <Ionicons
                  name={focused ? "menu" : "menu-outline"}
                  size={size}
                  color={focused ? Colors.light.primary : Colors.light.mutedForeground}
                />
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
