import React from "react";
import { Modal, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "../../hooks/use-colors";
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
      barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
      onBarcodeScanned={({ data }) => {
        if (handled.current) return;
        const value = data.trim();
        if (!value) return;
        handled.current = true;
        onScanned(value);
      }}
    />
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        {body}
        {permission?.granted ? (
          <View pointerEvents="none" style={styles.frameWrap}>
            <View style={[styles.frame, { borderColor: colors.primary }]} />
            <Label style={{ marginTop: 12 }}>POINT AT THE LABEL</Label>
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
  frameWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    width: 260,
    height: 130,
    borderWidth: 2,
    borderRadius: 12,
  },
  closeWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 32,
  },
});