import {
  receiptHeaderMetadata,
  THERMAL_RECEIPT_PRINT_CSS,
  type ReceiptBranchMetadata,
  type ReceiptContactMetadata,
} from "@/components/natex/receipt-print-metadata";

export interface CounterBookingReceiptData {
  awb: string;
  status: string;
  branch: ReceiptBranchMetadata;
  receiptContact?: ReceiptContactMetadata | null;
  originAddress: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  weightGrams: number;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  declaredValueCents: number;
  codAmountCents: number;
  bookedAt?: string | Date | null;
}

export interface ReceiptPrintWindow {
  document: {
    open(): void;
    write(markup: string): void;
    close(): void;
    images?: ArrayLike<HTMLImageElement>;
    fonts?: { ready: Promise<unknown> };
  };
  focus?(): void;
  print?(): void;
  close?(): void;
  readonly closed?: boolean;
}

export type OpenReceiptWindow = (
  url?: string,
  target?: string,
  features?: string,
) => ReceiptPrintWindow | null;

export function openCounterReceiptWindow(open: OpenReceiptWindow): ReceiptPrintWindow | null {
  try {
    // Open during the click that starts booking so popup blockers do not prevent
    // the later, asynchronous success callback from printing the receipt.
    const popup = open("", "_blank", "popup,width=420,height=720");
    if (popup && "opener" in popup) {
      try {
        (popup as ReceiptPrintWindow & { opener?: Window | null }).opener = null;
      } catch {
        // Some browsers expose opener as read-only; the popup remains usable.
      }
    }
    return popup;
  } catch {
    return null;
  }
}

export function closeCounterReceiptWindow(popup: ReceiptPrintWindow | null): void {
  if (!popup || popup.closed) return;
  try {
    popup.close?.();
  } catch {
    // A closed or browser-owned popup is already safe to leave alone.
  }
}

export function printCounterReceiptWindow(
  popup: ReceiptPrintWindow | null,
  markup: string,
  onFailure?: () => void,
): boolean {
  if (!popup || popup.closed) return false;
  try {
    popup.document.open();
    popup.document.write(markup);
    popup.document.close();
    const print = () => {
      if (popup.closed || !popup.print) throw new Error("Receipt window is unavailable");
      popup.focus?.();
      popup.print();
    };
    const images = Array.from(popup.document.images ?? []);
    if (images.length || popup.document.fonts) {
      const pending = images.map((image) => new Promise<void>((resolve, reject) => {
        if (image.complete) {
          if (image.naturalWidth > 0) resolve();
          else reject(new Error("Receipt logo could not be loaded"));
          return;
        }
        const timeout = setTimeout(() => reject(new Error("Receipt logo load timed out")), 10_000);
        image.addEventListener("load", () => { clearTimeout(timeout); resolve(); }, { once: true });
        image.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Receipt logo could not be loaded")); }, { once: true });
      }));
      if (popup.document.fonts) pending.push(popup.document.fonts.ready.then(() => undefined));
      void Promise.all(pending).then(print).catch(() => onFailure?.());
    } else {
      print();
    }
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(cents: number): string {
  return `Rs. ${(cents / 100).toFixed(2)}`;
}

function dimensions(data: CounterBookingReceiptData): string {
  return data.lengthCm && data.widthCm && data.heightCm
    ? `${data.lengthCm} × ${data.widthCm} × ${data.heightCm} cm`
    : "Not recorded";
}

function bookedAt(value: CounterBookingReceiptData["bookedAt"]): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-LK", { timeZone: "Asia/Colombo" });
}

export function renderCounterBookingReceipt(data: CounterBookingReceiptData): string {
  const header = receiptHeaderMetadata(data.branch, data.receiptContact);
  const cell = (label: string, value: string) => `<tr><td>${escapeHtml(label)}</td><td class="right">${escapeHtml(value)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>NatEx receipt ${escapeHtml(data.awb)}</title><style>
    body { margin: 0; font: 12px/1.25 Arial, sans-serif; color: #111; background: white }
    .retail-freight-slip { box-sizing: border-box; width: 80mm; padding: 4mm }
    .receipt-header { text-align: center } .receipt-logo { display: block; max-width: 28mm; max-height: 9mm; margin: 0 auto 1mm; filter: brightness(0) }
    .receipt-title { font-size: 14px; margin: 1mm 0 } p { margin: 1mm 0 }
    table { width: 100%; border-collapse: collapse } td { padding: 1mm 0; vertical-align: top }
    .right { text-align: right; overflow-wrap: anywhere }
    ${THERMAL_RECEIPT_PRINT_CSS}</style></head><body>
    <section class="retail-freight-slip" aria-label="NatEx counter booking receipt">
      <div class="receipt-content">
        <header class="receipt-header">
          <img class="receipt-logo" src="/natex-logo.png" alt="NatEx">
          <h1 class="receipt-title">NatEx · Hub Receipt</h1>
          <p class="receipt-subtitle">${escapeHtml(header.branchName)}</p>
          <p class="receipt-contact">${escapeHtml(header.branchAddress)}<br>Hub phone: ${escapeHtml(header.branchPhone)}<br>${escapeHtml(header.website)} · ${escapeHtml(header.companyPhone)}</p>
          <p class="receipt-code">Tracking number: <strong>${escapeHtml(data.awb)}</strong></p>
        </header>
        <table><tbody>
          ${cell("Booked at", bookedAt(data.bookedAt))}
          ${cell("Status", data.status)}
          ${cell("Weight", `${data.weightGrams} g`)}
          ${cell("Dimensions", dimensions(data))}
          ${cell("Declared value", money(data.declaredValueCents))}
          ${cell("COD to collect", data.codAmountCents > 0 ? money(data.codAmountCents) : "Prepaid")}
          ${cell("Pickup address", data.originAddress)}
          ${cell("Consignee", data.consigneeName)}
          ${cell("Consignee phone", data.consigneePhone)}
          ${cell("Delivery address", data.destAddress)}
        </tbody></table>
        <p class="receipt-contact">Keep this receipt for tracking. Present the tracking number for any reprint request.</p>
      </div>
    </section>
  </body></html>`;
}
