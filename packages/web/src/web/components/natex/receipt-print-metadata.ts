/**
 * Metadata and print rules shared by the Operations Counter receipt.
 *
 * The NatEx website is an existing configured identity. Company and branch
 * phones are deliberately optional: never substitute a staff or merchant
 * number, and never render the old sample company number as verified data.
 */
export const NATEX_WEBSITE = "natex.lk";
/** Kept as an export for callers that used the old constant; intentionally blank. */
export const NATEX_COMPANY_PHONE = "";

export interface ReceiptBranchMetadata {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface ReceiptContactMetadata {
  website?: string | null;
  companyPhone?: string | null;
}

export interface ReceiptHeaderMetadata {
  branchName: string;
  branchAddress: string;
  branchPhone: string;
  website: string;
  companyPhone: string;
}

/** Return a printable value without ever rendering an empty metadata line. */
export function receiptText(value: string | null | undefined, fallback = "Not configured"): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

export function receiptHeaderMetadata(
  branch?: ReceiptBranchMetadata | null,
  contact?: ReceiptContactMetadata | null,
): ReceiptHeaderMetadata {
  return {
    branchName: receiptText(branch?.name, "Branch / hub"),
    branchAddress: receiptText(branch?.address),
    branchPhone: receiptText(branch?.phone),
    website: receiptText(contact?.website, NATEX_WEBSITE),
    companyPhone: receiptText(contact?.companyPhone ?? NATEX_COMPANY_PHONE),
  };
}

/** Narrow-printer CSS: no A5/A6 height, no clipping, and no wide two-column header. */
export const THERMAL_RECEIPT_PRINT_CSS = `
@page { size: auto; margin: 0 }
@media print {
  body * { visibility: hidden !important }
  .retail-freight-slip, .retail-freight-slip * { visibility: visible !important }
  .retail-freight-slip {
    display: block !important;
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    width: 80mm !important;
    min-height: 0 !important;
    max-width: none !important;
    box-sizing: border-box !important;
    overflow: visible !important;
    margin: 0 !important;
    padding: 4mm !important;
    background: #fff !important;
    color: #111 !important;
    font: 8pt/1.25 Arial, sans-serif !important;
    border: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  .retail-freight-slip table { width: 100%; border-collapse: collapse }
  .retail-freight-slip td { padding: 1.2mm 0; border-bottom: 0.2mm solid #ddd; vertical-align: top }
  .retail-freight-slip .right { text-align: right; font-family: monospace; overflow-wrap: anywhere }
  .retail-freight-slip img { max-width: 32mm; max-height: 12mm; object-fit: contain }
  .retail-freight-slip .receipt-logo { max-width: 28mm !important; max-height: 9mm !important; margin: 0 auto 1mm !important; filter: brightness(0) !important }
  .retail-freight-slip .receipt-header { display: block !important; text-align: center !important }
  .retail-freight-slip .receipt-title { font-size: 10pt; line-height: 1.05; margin: 0 }
  .retail-freight-slip .receipt-subtitle { font-size: 7pt; margin: 0.5mm 0 0 }
  .retail-freight-slip .receipt-contact { font-size: 7pt; line-height: 1.25; overflow-wrap: anywhere }
  .retail-freight-slip .receipt-code { margin-top: 1mm; font-size: 8pt }
  .retail-freight-slip .receipt-content { position: relative; z-index: 2 }
  .retail-freight-slip .receipt-watermark { position: absolute; z-index: 1; top: 47%; left: 7%; transform: rotate(-27deg); font-size: 27pt; font-weight: 800; letter-spacing: 2mm; color: rgba(160,0,0,.12); white-space: nowrap }
  [role="dialog"] { position: static !important; inset: auto !important; left: auto !important; top: auto !important; transform: none !important; translate: none !important; width: auto !important; max-width: none !important; max-height: none !important; overflow: visible !important; margin: 0 !important; padding: 0 !important; border: 0 !important; box-shadow: none !important }
}
`;
