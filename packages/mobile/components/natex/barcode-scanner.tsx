import React from "react";
import { Modal, Platform, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "../../hooks/use-colors";
import { getSettings, useSettings } from "../../lib/settings";
import { Button } from "./button";
import { Body, Label } from "./text";

/**
 * Full-screen camera sheet that reads one barcode and hands the decoded text
 * back. Parcel labels are Code 128; the wider type list costs nothing and
 * covers QR on newer label stock.
 *
 * Expo Camera batches scan callbacks aggressively — without the `handled`
 * latch one label would fire onScanned a dozen times before the modal
 * finishes closing, and the caller would submit the same AWB repeatedly.
 *
 * The camera view is masked to a cutout: everything outside the scan window
 * is filled black, so the only live pixels on screen are the label the rider
 * is pointing at. Torch and haptic feedback follow the Settings tab.
 */

const BARCODE_TYPES = [
  "code128",
  "code39",
  "code93",
  "codabar",
  "ean13",
  "ean8",
  "upc_a",
  "upc_e",
  "itf14",
  "qr",
  "pdf417",
  "datamatrix",
  "aztec",
] as const;

interface BarcodeScannerProps {
  visible: boolean;
  onScanned: (value: string) => void;
  onClose: () => void;
}

export function BarcodeScanner({ visible, onScanned, onClose }: BarcodeScannerProps) {
  const colors = useColors();
  const settings = useSettings();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (!visible) return;
    handled.current = false;
    if (permission && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [visible, permission, requestPermission]);

  const body = !permission ? (
    <View style={styles.center}>
      <Body>Starting the camera…</Body>
    </View>
  ) : !permission.granted ? (
    <View style={[styles.center, { padding: 24 }]}>
      <Ionicons name="camera-outline" size={40} color={colors.mutedForeground} />
      <Body style={{ textAlign: "center", marginTop: 12 }}>
        The camera is needed to scan parcel labels. Allow it, or type the AWB instead.
      </Body>
      {permission.canAskAgain ? (
        <Button title="Allow camera" style={{ marginTop: 16 }} onPress={() => void requestPermission()} />
      ) : (
        <Body color={colors.mutedForeground} style={{ textAlign: "center", marginTop: 16 }}>
          Camera access is off for NatEx in the phone settings.
        </Body>
      )}
    </View>
  ) : (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      enableTorch={settings.scannerTorch}
      barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
      onBarcodeScanned={({ data }) => {
        if (handled.current) return;
        const value = data.trim();
        if (!value) return;
        handled.current = true;
        if (getSettings().vibrateOnScan && Platform.OS !== "web") {
          // Fire-and-forget: feedback must never delay the scan callback.
          void import("expo-haptics")
            .then((Haptics) => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
            .catch(() => {});
        }
        onScanned(value);
      }}
    />
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: "#000" }]}>
        {body}
        {permission?.granted ? (
          // Black mask around the scan window — only the label area stays live.
          <View pointerEvents="none" style={styles.maskWrap}>
            <View style={styles.maskFill} />
            <View style={styles.maskRow}>
              <View style={styles.maskFill} />
              <View style={[styles.window, { borderColor: colors.primary }]}>
                <View style={[styles.corner, styles.cornerTL, { borderColor: colors.primary }]} />
                <View style={[styles.corner, styles.cornerTR, { borderColor: colors.primary }]} />
                <View style={[styles.corner, styles.cornerBL, { borderColor: colors.primary }]} />
                <View style={[styles.corner, styles.cornerBR, { borderColor: colors.primary }]} />
              </View>
              <View style={styles.maskFill} />
            </View>
            <View style={[styles.maskFill, styles.maskBottom]}>
              <Label style={{ marginTop: 20 }}>POINT AT THE LABEL</Label>
            </View>
          </View>
        ) : null}
        <View style={styles.closeWrap}>
          <Button
            title="Close"
            variant="secondary"
            icon={<Ionicons name="close" size={18} color={colors.foreground} />}
            onPress={onClose}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  maskWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  maskRow: {
    flexDirection: "row",
  },
  maskFill: {
    flex: 1,
    backgroundColor: "#000",
  },
  maskBottom: {
    alignItems: "center",
  },
  window: {
    width: 280,
    height: 140,
    borderWidth: 2,
    borderRadius: 14,
  },
  corner: {
    position: "absolute",
    width: 26,
    height: 26,
    borderWidth: 4,
  },
  cornerTL: { top: -2, left: -2, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 14 },
  cornerTR: { top: -2, right: -2, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 14 },
  cornerBL: { bottom: -2, left: -2, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 14 },
  cornerBR: { bottom: -2, right: -2, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 14 },
  closeWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 32,
  },
});