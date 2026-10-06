// System-managed layout — extend in place, never rewrite from scratch.
// Keep the provider chain intact: ErrorBoundary → OneDollarStats → SafeArea → QueryClient.
// To switch navigation, replace only the <Slot /> line with <Stack /> or <Tabs />.
import { useEffect } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { PlusJakartaSans_600SemiBold, PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans";
import { IBMPlexSans_400Regular, IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans";
import { IBMPlexMono_500Medium, IBMPlexMono_600SemiBold } from "@expo-google-fonts/ibm-plex-mono";
import { ErrorBoundary } from "../components/__ErrorBoundary";
import { OneDollarStatsProvider } from "../lib/__analytics";
import { isWeb, startWebSafeArea } from "../lib/__web-safe-area";
import { AuthProvider } from "../lib/auth";
import { hydrateTheme, useResolvedScheme } from "../lib/theme";
import { hydrateSettings } from "../lib/settings";
import { Colors } from "../constants/theme";
import appJson from "../app.json";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A rider on a basement staircase will lose the network for a minute at a
      // time. Retrying once absorbs that; retrying forever hides it.
      retry: 1,
      staleTime: 15_000,
    },
  },
});

const applicationId = appJson.expo.extra.applicationId ?? "";
const hostname = applicationId ? `${applicationId}-mobile` : "localhost";

export default function RootLayout() {
  useEffect(() => {
    if (isWeb) startWebSafeArea();
    void hydrateTheme();
    void hydrateSettings();
  }, []);

  const scheme = useResolvedScheme();
  const shell = Colors[scheme];

  const [fontsLoaded] = useFonts({
    PlusJakartaSans_700Bold,
    PlusJakartaSans_600SemiBold,
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  return (
    <ErrorBoundary>
      {/* Runable analytics provider — do not remove, required for analytics tracking */}
      <OneDollarStatsProvider
        config={{
          hostname,
          collectorUrl: "https://r.lilstts.com/events",
          devmode: true,
        }}
      >
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            {/* Status-bar glyphs invert with the rider's Dark/Day choice. */}
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            {fontsLoaded ? (
              <AuthProvider>
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: shell.background },
                    animation: "fade",
                  }}
                />
              </AuthProvider>
            ) : (
              // Fonts are part of the design contract (mono AWBs are how a
              // mistyped digit gets caught), so the shell holds rather than
              // flashing a system-font frame.
              <View style={{ flex: 1, backgroundColor: shell.background }} />
            )}
          </QueryClientProvider>
        </SafeAreaProvider>
      </OneDollarStatsProvider>
    </ErrorBoundary>
  );
}
