import { Camera } from "expo-camera";
import type { DistrictGroups, MerchantLabelSuggestions } from "./merchant-label-ocr";
import { parseMerchantLabelText } from "./merchant-label-ocr";

const PARCEL_LABEL_BARCODE_TYPES = ["code128", "code39", "code93", "qr", "pdf417"] as const;

export async function scanMerchantLabelPhoto(
  imageUri: string,
  districtsByProvince: DistrictGroups,
): Promise<MerchantLabelSuggestions> {
  // Load only on demand. Non-Merchant native variants exclude this native module.
  const ocr = await import("expo-text-extractor");
  if (!ocr.isSupported) {
    throw new Error("Label OCR is not supported by this app build.");
  }

  const [textBlocks, barcodes] = await Promise.all([
    ocr.extractTextFromImage(imageUri),
    Camera.scanFromURLAsync(imageUri, [...PARCEL_LABEL_BARCODE_TYPES]).catch(() => []),
  ]);

  return parseMerchantLabelText(
    textBlocks,
    barcodes.map((barcode) => barcode.data),
    districtsByProvince,
  );
}
