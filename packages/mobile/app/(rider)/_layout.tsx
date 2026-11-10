import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useOutboxDriver, useReasonCodes, useRiderRun } from "../../hooks/use-rider-run";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Platform } from "react-native";

/**
 * §7 plumbing that must run on EVERY rider screen, not just the run list: a
 * rider can land on a stop straight from a notification or a cold start, and
 * that screen has to see the queue already on disk. Mounted once, inside the
 * role gate so it only ever runs for a signed-in rider.
 */
function OutboxDriver() {
  const runQuery = useRiderRun();
  useOutboxDriver(runQuery.data?.run ?? null);
  // The failure screen's reason list must be on the phone BEFORE signal goes.
  useReasonCodes();
  return null;
}

/**
 * The rider's four tabs, and nothing else.
 *
 * The rider's whole day (§5, §10 M3): collect from merchants, hand in at the
 * hub, take the delivery run out. The tab bar carries those three plus the
 * profile — every extra tab is a tab a thumb has to avoid while holding a
 * parcel. Individual stops and manifests are pushed screens, not tabs.
 */
export default function RiderLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const bottomInset = Math.max(insets.bottom, 12);

  return (
    <RoleGate allow={["rider"]}>
      <OutboxDriver />
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
            title: "Pickups",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "cube" : "cube-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="deliveries"
          options={{
            title: "Run",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "bicycle" : "bicycle-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="handin"
          options={{
            title: "Hand in",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "log-in" : "log-in-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Me",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "settings" : "settings-outline"}
                size={size}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        {/* Reached from a pickup card, not from the tab bar. */}
        <Tabs.Screen name="manifest/[id]" options={{ href: null }} />
        {/* Reached from a delivery stop card. */}
        <Tabs.Screen name="stop/[awb]" options={{ href: null }} />
        {/* Completed and failed outcome lists live in the Rider drawer. */}
        <Tabs.Screen name="delivered" options={{ href: null }} />
        <Tabs.Screen name="failed-attempts" options={{ href: null }} />
      </Tabs>
    </RoleGate>
  );
}
