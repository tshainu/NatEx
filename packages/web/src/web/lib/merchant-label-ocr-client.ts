import { parseMerchantLabelText, type MerchantLabelSuggestions } from "./merchant-label-ocr";

export interface MerchantLabelRecognition {
  suggestions: MerchantLabelSuggestions;
  barcodeRead: boolean;
  textRead: boolean;
  ocrFailed: boolean;
}

export type OcrProgress = (percent: number) => void;

function localOcrAsset(path: string): string {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin);
  return new URL(`ocr/${path}`, base).href;
}

/**
 * Read a selected image locally in the browser. The image is supplied directly
 * to ZXing/Tesseract and is never sent to a NatEx API or external OCR service.
 */
export async function recognizeMerchantLabelImage(
  file: File,
  onProgress: OcrProgress = () => undefined,
): Promise<MerchantLabelRecognition> {
  const imageUrl = URL.createObjectURL(file);
  let barcodeValue = "";
  let rawText = "";
  let ocrFailed = false;
  let terminateWorker: (() => Promise<unknown>) | null = null;

  try {
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();
      barcodeValue = (await reader.decodeFromImageUrl(imageUrl)).getText();
    } catch {
      // A label without a decodable barcode may still have readable OCR text.
    }

    try {
      const tesseractModule = await import("tesseract.js");
      const tesseract = tesseractModule.default;
      const corePath = localOcrAsset("core/");
      const langPath = localOcrAsset("lang/");
      const worker = await tesseract.createWorker("eng", tesseract.OEM.LSTM_ONLY, {
        workerPath: localOcrAsset("worker.min.js"),
        corePath,
        langPath,
        workerBlobURL: false,
        gzip: true,
        logger: (message) => {
          if (message.status === "recognizing text") {
            onProgress(Math.max(0, Math.min(100, Math.round(message.progress * 100))));
          }
        },
      });
      terminateWorker = () => worker.terminate();
      const result = await worker.recognize(file, { rotateAuto: true }, { text: true });
      rawText = result.data.text ?? "";
    } catch {
      ocrFailed = true;
    }
  } finally {
    if (terminateWorker) {
      try {
        await terminateWorker();
      } catch {
        // The temporary image URL is still revoked even if worker cleanup fails.
      }
    }
    URL.revokeObjectURL(imageUrl);
  }

  const suggestions = parseMerchantLabelText(rawText, barcodeValue);
  return {
    suggestions,
    barcodeRead: /^NX\D*\d{10}$/i.test(barcodeValue.trim()),
    textRead: Boolean(rawText.trim()),
    ocrFailed,
  };
}
