import * as React from "react";
import { ImagePlus, LoaderCircle, ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/natex/page";
import type { AddressParts } from "@/lib/address";
import { recognizeMerchantLabelImage } from "@/lib/merchant-label-ocr-client";
import type { MerchantLabelSuggestions } from "@/lib/merchant-label-ocr";

export interface MerchantOcrValues {
  awb: string | null;
  consigneeName: string | null;
  consigneePhone: string | null;
  destAddress: AddressParts | null;
}

export function MerchantLabelOcrCard({
  registeredFromAddress,
  onApply,
}: {
  registeredFromAddress: string;
  onApply: (values: MerchantOcrValues) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState("");
  const [suggestions, setSuggestions] = React.useState<MerchantLabelSuggestions | null>(null);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [barcodeRead, setBarcodeRead] = React.useState(false);

  React.useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const clear = () => {
    setPreviewUrl(null);
    setFileName("");
    setSuggestions(null);
    setProgress(null);
    setWorking(false);
    setError(null);
    setNotice(null);
    setBarcodeRead(false);
  };

  const readImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file of the parcel label.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("This image is over 20 MB. Choose a smaller or closer photo; it is not uploaded.");
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    setFileName(file.name || "Parcel label photo");
    setSuggestions(null);
    setError(null);
    setNotice(null);
    setProgress(0);
    setWorking(true);
    try {
      const result = await recognizeMerchantLabelImage(file, setProgress);
      setSuggestions(result.suggestions);
      setBarcodeRead(result.barcodeRead);
      const hasSuggestions = Boolean(
        result.suggestions.awb ||
          result.suggestions.consigneeName ||
          result.suggestions.consigneePhone ||
          result.suggestions.toAddressText ||
          result.suggestions.fromAddressText,
      );
      if (!hasSuggestions) {
        setError(
          result.ocrFailed
            ? "The local text reader could not process this image. You can still enter the parcel details manually."
            : "No label details were clear enough to suggest. Try a closer, brighter photo or enter details manually.",
        );
      } else if (result.ocrFailed) {
        setNotice("Some label text could not be read. Review every field before booking.");
      } else if (!result.textRead && result.barcodeRead) {
        setNotice("Tracking barcode read. Address text was not clear; enter it manually.");
      } else {
        setNotice("Suggestions are best-effort. Review and correct them before booking.");
      }
    } catch {
      setError("The label could not be read in this browser. Enter the parcel details manually.");
    } finally {
      setWorking(false);
      setProgress(null);
    }
  };

  const hasApplicableValue = Boolean(
    suggestions?.awb ||
      suggestions?.consigneeName ||
      suggestions?.consigneePhone ||
      suggestions?.destAddress,
  );

  return (
    <Card title="Read a parcel label">
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Upload a clear photo or take one now. NatEx reads the image in this browser; the photo is not uploaded or saved.
          Printed text works best. Handwriting may need manual correction.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Choose a parcel address-label image"
            onChange={(event) => void readImage(event)}
          />
          <Button type="button" size="sm" onClick={() => inputRef.current?.click()} disabled={working}>
            {working ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <ImagePlus className="size-4" aria-hidden />}
            {working ? "Reading label…" : "Upload or take photo"}
          </Button>
          {previewUrl ? (
            <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={working}>
              <X className="size-4" aria-hidden /> Clear scan
            </Button>
          ) : null}
          {fileName ? <span className="max-w-56 truncate text-[12px] text-muted-foreground">{fileName}</span> : null}
        </div>

        {working ? (
          <output className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2" aria-live="polite">
            <ScanLine className="size-4 shrink-0 text-brand" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium">Reading locally — {progress ?? 0}%</p>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full bg-brand transition-[width]" style={{ width: `${progress ?? 0}%` }} />
              </div>
            </div>
          </output>
        ) : null}

        {previewUrl ? (
          <div className="flex flex-wrap items-start gap-4 rounded-md border border-border p-3">
            <img src={previewUrl} alt="Selected parcel address label preview" className="max-h-40 max-w-40 rounded object-contain" />
            <div className="min-w-0 flex-1 space-y-3 text-[13px]">
              {suggestions?.awb ? <p><span className="text-muted-foreground">Tracking number</span><br /><span className="font-mono font-semibold">{suggestions.awb}</span>{barcodeRead ? <span className="ml-2 text-status-good">barcode</span> : null}</p> : null}
              {suggestions?.consigneeName ? <p><span className="text-muted-foreground">Recipient</span><br />{suggestions.consigneeName}</p> : null}
              {suggestions?.consigneePhone ? <p><span className="text-muted-foreground">Phone</span><br /><span className="font-mono">{suggestions.consigneePhone}</span></p> : null}
              {suggestions?.toAddressText ? <p><span className="text-muted-foreground">To address read from label</span><br />{suggestions.toAddressText}</p> : null}
              {suggestions?.fromAddressText ? (
                <div className="rounded border border-border bg-muted/30 p-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">From address comparison only</p>
                  <p className="mt-1">Label: {suggestions.fromAddressText}</p>
                  <p className="mt-1">NatEx pickup address on file: {registeredFromAddress || "Not available"}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Booking always uses the registered address on file.</p>
                </div>
              ) : null}
              {notice ? <p className="text-[12px] text-muted-foreground">{notice}</p> : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (!suggestions) return;
                  onApply({
                    awb: suggestions.awb,
                    consigneeName: suggestions.consigneeName,
                    consigneePhone: suggestions.consigneePhone,
                    destAddress: suggestions.destAddress,
                  });
                }}
                disabled={!hasApplicableValue || working}
              >
                Fill blank booking fields
              </Button>
              <p className="text-[11px] text-muted-foreground">Existing entries will not be overwritten. Edit all fields and confirm the booking yourself.</p>
            </div>
          </div>
        ) : null}
        {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
      </div>
    </Card>
  );
}
