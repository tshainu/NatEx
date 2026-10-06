import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { Fonts, Space, Type } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { useOutboxDriver, useReasonCodes, useRiderRun } from "../../hooks/use-rider-run";

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

  return (
    <RoleGate allow={["rider"]}>
      <OutboxDriver />
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
            title: "Pickups",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "cube" : "cube-outline"} size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="deliveries"
          options={{
            title: "Deliveries",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "bicycle" : "bicycle-outline"} size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="handin"
          options={{
            title: "Hand in",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons
                name={focused ? "log-in" : "log-in-outline"}
                size={size}
                color={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? "settings" : "settings-outline"} size={size} color={color} />
            ),
          }}
        />
        {/* Reached from a pickup card, not from the tab bar. */}
        <Tabs.Screen name="manifest/[id]" options={{ href: null }} />
        {/* Reached from a delivery stop card. */}
        <Tabs.Screen name="stop/[awb]" options={{ href: null }} />
      </Tabs>
    </RoleGate>
  );
}
