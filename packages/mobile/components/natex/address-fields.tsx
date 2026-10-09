import React, { useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "../../hooks/use-colors";
import { Space } from "../../constants/theme";
import { Body, Small, Title } from "./text";
import { Input } from "./input";

export const DISTRICTS_BY_PROVINCE = {
  "Western Province": ["Colombo", "Gampaha", "Kalutara"],
  "Central Province": ["Kandy", "Matale", "Nuwara Eliya"],
  "Southern Province": ["Galle", "Matara", "Hambantota"],
  "Northern Province": ["Jaffna", "Kilinochchi", "Mannar", "Mullaitivu", "Vavuniya"],
  "Eastern Province": ["Ampara", "Batticaloa", "Trincomalee"],
  "North Western Province": ["Kurunegala", "Puttalam"],
  "North Central Province": ["Anuradhapura", "Polonnaruwa"],
  "Uva Province": ["Badulla", "Monaragala"],
  "Sabaragamuwa Province": ["Kegalle", "Ratnapura"],
} as const;
export type Province = keyof typeof DISTRICTS_BY_PROVINCE;
export type District = (typeof DISTRICTS_BY_PROVINCE)[Province][number];
export interface AddressParts {
  line1: string;
  line2: string;
  district: District | "";
  province: Province | "";
}
export const EMPTY_ADDRESS: AddressParts = { line1: "", line2: "", district: "", province: "" };
export function formatAddress(parts: AddressParts): string {
  return [parts.line1.trim(), parts.line2.trim(), parts.district, parts.province].filter(Boolean).join(", ");
}
export function isCompleteAddress(parts: AddressParts): boolean {
  return parts.line1.trim().length >= 3 && Boolean(parts.district && parts.province) &&
    (DISTRICTS_BY_PROVINCE[parts.province as Province] as readonly string[]).includes(parts.district);
}

export function AddressFields({
  value,
  onChange,
}: {
  value: AddressParts;
  onChange: (next: AddressParts) => void;
}) {
  const colors = useColors();
  const [picker, setPicker] = useState<"province" | "district" | null>(null);
  const provinces = Object.keys(DISTRICTS_BY_PROVINCE) as Province[];
  const districts = value.province ? DISTRICTS_BY_PROVINCE[value.province] : [];
  const options: readonly string[] = picker === "province" ? provinces : districts;
  const update = (patch: Partial<AddressParts>) => onChange({ ...value, ...patch });
  const selected = picker === "province" ? value.province : value.district;

  return (
    <View style={styles.wrap}>
      <Input label="Address line 1" value={value.line1} onChangeText={(line1) => update({ line1 })} autoComplete="street-address" placeholder="Building, street and number" returnKeyType="next" />
      <Input label="Address line 2" value={value.line2} onChangeText={(line2) => update({ line2 })} placeholder="Apartment, floor or landmark (optional)" returnKeyType="next" />
      <View style={styles.row}>
        <View style={styles.flex}>
          <Small>Province</Small>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose province" onPress={() => setPicker("province")} style={[styles.select, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Body numberOfLines={1} style={styles.flex}>{value.province || "Select province"}</Body>
            <Ionicons name="chevron-down" size={17} color={colors.mutedForeground} />
          </Pressable>
        </View>
        <View style={styles.flex}>
          <Small>District</Small>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose district" disabled={!value.province} onPress={() => setPicker("district")} style={[styles.select, { backgroundColor: colors.surface, borderColor: colors.border, opacity: value.province ? 1 : 0.55 }]}>
            <Body numberOfLines={1} style={styles.flex}>{value.district || "Select district"}</Body>
            <Ionicons name="chevron-down" size={17} color={colors.mutedForeground} />
          </Pressable>
        </View>
      </View>
      <Modal visible={picker !== null} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPicker(null)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={(event) => event.stopPropagation()}>
            <View style={styles.sheetHeader}>
              <Title>{picker === "province" ? "Choose province" : "Choose district"}</Title>
              <Pressable accessibilityRole="button" accessibilityLabel="Close selector" onPress={() => setPicker(null)} hitSlop={12}>
                <Ionicons name="close" size={22} color={colors.foreground} />
              </Pressable>
            </View>
            <FlatList
              data={options as string[]}
              keyExtractor={(item) => item}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: selected === item }}
                  onPress={() => {
                    if (picker === "province") update({ province: item as Province, district: "" });
                    else update({ district: item as District });
                    setPicker(null);
                  }}
                  style={[styles.option, { borderBottomColor: colors.border }]}
                >
                  <Body>{item}</Body>
                  {selected === item ? <Ionicons name="checkmark" size={20} color="#176B2C" /> : null}
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Space.unit },
  row: { flexDirection: "row", gap: Space.unit },
  flex: { flex: 1 },
  select: { minHeight: Space.minTouch, borderWidth: 1, borderRadius: Space.radius, paddingHorizontal: Space.card, marginTop: 5, flexDirection: "row", alignItems: "center", gap: 6 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.38)", justifyContent: "flex-end", padding: Space.page },
  sheet: { maxHeight: "76%", borderWidth: 1, borderRadius: 18, padding: Space.card, gap: Space.unit },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: Space.unit },
  option: { minHeight: Space.minTouch, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Space.unit },
});
