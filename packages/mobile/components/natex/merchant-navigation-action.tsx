import React from "react";
import { Alert, Linking, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Space } from "../../constants/theme";
import { useColors } from "../../hooks/use-colors";
import { formatCoordinates, googleMapsDirectionsUrl } from "../../lib/maps";
import { Body, Small } from "./text";

export function MerchantNavigationAction({
  merchantName,
  address,
  latitude,
  longitude,
}: {
  merchantName: string;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}) {
  const colors = useColors();
  const coordinates = formatCoordinates(latitude, longitude);
  const mapsUrl = googleMapsDirectionsUrl({ latitude, longitude, address });
  const cleanAddress = address?.trim();
  const disabled = !mapsUrl;

  function openDirections() {
    if (!mapsUrl) return;
    void Linking.openURL(mapsUrl).catch(() => {
      Alert.alert(
        "Could not open Google Maps",
        "Check that a browser or Google Maps is available on this device, then try again.",
      );
    });
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Navigate to ${merchantName} in Google Maps`}
      accessibilityHint="Opens directions to the merchant pickup location"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={openDirections}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.surface, borderColor: colors.border },
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Ionicons
        name="navigate-circle-outline"
        size={24}
        color={disabled ? colors.mutedForeground : colors.primary}
      />
      <View style={styles.copy}>
        <Body color={disabled ? colors.mutedForeground : colors.primary}>
          {disabled ? "Merchant location unavailable" : "Navigate to merchant"}
        </Body>
        <Small>
          {coordinates
            ? `GPS · ${coordinates}`
            : cleanAddress
              ? "GPS pin not set · using saved address"
              : "No GPS pin or saved address"}
        </Small>
        {cleanAddress ? <Small>{cleanAddress}</Small> : null}
      </View>
      {!disabled ? <Ionicons name="open-outline" size={18} color={colors.mutedForeground} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    minHeight: Space.minTouch,
    flexDirection: "row",
    alignItems: "center",
    gap: Space.unit,
    borderWidth: 1,
    borderRadius: Space.radius,
    padding: Space.unit,
  },
  copy: { flex: 1, gap: 2 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.75 },
});
