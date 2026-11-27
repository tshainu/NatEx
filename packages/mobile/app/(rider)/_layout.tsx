import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { RoleGate } from "../../components/natex/role-gate";
import { AnimatedWaveTabBar } from "../../components/natex/animated-wave-tab-bar";
import { useColors } from "../../hooks/use-colors";
import { useOutboxDriver, useReasonCodes, useRiderRun } from "../../hooks/use-rider-run";
import { Alert } from "react-native";
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../lib/api";
import { flushRiderGps, startRiderGps, stopRiderGps } from "../../lib/rider-gps";
import { RiderDrawerProvider } from "../../components/natex/rider-drawer";
import { useAuth } from "../../lib/auth";

/**
 * §7 plumbing that must run on EVERY rider screen, not just the run list: a
 * rider can land on a stop straight from a notification or a cold start, and
 * that screen has to see the queue already on disk. Mounted once, inside the
 * role gate so it only ever runs for a signed-in rider.
 */
function OutboxDriver() {
  const { role } = useAuth();
  const riderEnabled = role === "rider";
  const runQuery = useRiderRun(riderEnabled);
  useOutboxDriver(runQuery.data?.run ?? null);
  // The failure screen's reason list must be on the phone BEFORE signal goes.
  useReasonCodes(riderEnabled);
  return null;
}

function GpsDriver() {
  const { role } = useAuth();
  const status = useQuery({ ...orpc.hr.clockStatus.queryOptions({ input: {} }), enabled: role === "rider", refetchInterval: 30_000 });
  const clockedIn = Boolean(status.data?.row?.clockInAt && !status.data?.row?.clockOutAt);
  const warned = useRef(false);
  useEffect(() => {
    if (!clockedIn) {
      void (async () => { await flushRiderGps(status.data?.workDate); await stopRiderGps(); })();
      warned.current = false;
      return;
    }
    void startRiderGps().then((result) => {
      if (!result.enabled && !warned.current) {
        warned.current = true;
        Alert.alert("GPS is required for your shift", result.message ?? "Switch on GPS permission so NatEx can record your route while you are clocked in.");
      }
    });
    const timer = setInterval(() => { void flushRiderGps(status.data?.workDate); }, 30_000);
    return () => clearInterval(timer);
  }, [clockedIn, status.data?.workDate]);
  return null;
}

/**
 * The rider's five primary tabs, and nothing else.
 *
 * The rider's whole day (§5, §10 M3): collect from merchants, hand in at the
 * hub, take the delivery run out. The tab bar carries those three plus the
 * profile — every extra tab is a tab a thumb has to avoid while holding a
 * parcel. Individual stops and manifests are pushed screens, not tabs.
 */
export default function RiderLayout() {
  const colors = useColors();
  return (
    <RoleGate allow={["rider", "transport"]}>
      <RiderDrawerProvider>
      <OutboxDriver />
      <GpsDriver />
      <Tabs
        initialRouteName="home"
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
            title: "Pick-ups",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "cube" : "cube-outline"}
                size={25}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="deliveries"
          options={{
            title: "Delivery",
            tabBarIcon: ({ size, focused }) => (
              <MaterialCommunityIcons
                name="motorbike"
                size={25}
                color={focused ? colors.primary : colors.mutedForeground}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="home"
          options={{
            title: "Home",
            tabBarIcon: ({ size, focused }) => (
              <Ionicons
                name={focused ? "home" : "home-outline"}
                size={focused ? 29 : 27}
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
                size={25}
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
                size={25}
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
        <Tabs.Screen name="day-registry" options={{ href: null }} />
        <Tabs.Screen name="enroll-merchant" options={{ href: null }} />
        <Tabs.Screen name="route" options={{ href: null }} />
        <Tabs.Screen name="transport" options={{ href: null }} />
        <Tabs.Screen name="ops" options={{ href: null }} />
        <Tabs.Screen name="ops-bags" options={{ href: null }} />
        <Tabs.Screen name="ops-transport" options={{ href: null }} />
        <Tabs.Screen name="ops-inbound" options={{ href: null }} />
        <Tabs.Screen name="ops-arrived" options={{ href: null }} />
        <Tabs.Screen name="overtime" options={{ href: null }} />
        <Tabs.Screen name="leave" options={{ href: null }} />
      </Tabs>
      </RiderDrawerProvider>
    </RoleGate>
  );
}
