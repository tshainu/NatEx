export interface AddressLabelData {
  awb: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
  senderName: string;
  senderPhone?: string | null;
  senderAddress: string;
  weightGrams: number;
  codStatus: string;
  codAmountCents: number;
  deliveryCharge: string;
  totalCollectCents: number;
  advancedPaidCents: number;
  description?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function labelMoney(cents: number): string {
  return `${new Intl.NumberFormat("en-LK", { maximumFractionDigits: 0 }).format(cents / 100)}/-`;
}

function text(value: string | null | undefined, fallback = "-"): string {
  const trimmed = value?.trim();
  return escapeHtml(trimmed || fallback);
}

function weightLabel(weightGrams: number): string {
  const kilograms = weightGrams / 1000;
  return `${Number.isInteger(kilograms) ? kilograms : kilograms.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")} kg`;
}

/** Print-ready 6 × 3 inch NatEx label matching the supplied reference layout. */
export function renderAddressLabel(data: AddressLabelData): string {
  const detailRow = (label: string, value: string, className = "") =>
    `<tr class="${className}"><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
  const advancedPaid = data.advancedPaidCents > 0 ? labelMoney(data.advancedPaidCents) : "-";
  return `<!doctype html><html><head><meta charset="utf-8"><title>NatEx address label ${escapeHtml(data.awb)}</title><style>
    @page { size: 6in 3in; margin: 0 }
    * { box-sizing: border-box }
    html, body { width: 6in; height: 3in; margin: 0; padding: 0; background: #fff; color: #252525; font-family: Arial, Helvetica, sans-serif }
    body { overflow: hidden }
    .label { width: 6in; height: 3in; display: grid; grid-template-columns: 0.92in 5.08in; background: #fff }
    .logo-panel { width: 0.92in; height: 3in; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #fff }
    .logo-panel img { display: block; width: 2.72in; height: auto; max-width: none; flex: 0 0 auto; transform: rotate(-90deg); transform-origin: center center }
    .document { width: 5.08in; height: 3in; display: grid; grid-template-columns: 1.64fr 1fr; border: 1px solid #222 }
    .left-column { min-width: 0; display: grid; grid-template-rows: 1.78fr 1fr; border-right: 1px solid #222 }
    .to-block, .from-block { min-width: 0; padding: 0.13in 0.10in 0.08in 0.10in; overflow: hidden }
    .from-block { border-top: 1px solid #222; padding-top: 0.10in }
    .section-label { margin: 0 0 0.10in; font-size: 0.14in; line-height: 1; font-weight: 400 }
    .recipient-name { margin: 0 0 0.03in; font-size: 0.285in; line-height: 1.08; font-weight: 400; overflow-wrap: anywhere }
    .recipient-address { margin: 0; font-size: 0.255in; line-height: 1.13; white-space: pre-line; overflow-wrap: anywhere }
    .recipient-phone { margin: 0.04in 0 0; font-size: 0.13in; font-weight: 600 }
    .sender-name { margin: 0 0 0.02in; font-size: 0.20in; line-height: 1.05; font-weight: 700; overflow-wrap: anywhere }
    .sender-address { margin: 0; font-size: 0.18in; line-height: 1.12; white-space: pre-line; overflow-wrap: anywhere }
    .sender-phone { margin: 0.03in 0 0; font-size: 0.12in; font-weight: 600 }
    .right-column { min-width: 0; display: grid; grid-template-rows: 1.56in 1fr }
    .package-detail { min-width: 0; overflow: hidden }
    .package-title { height: 0.43in; display: flex; align-items: center; justify-content: center; border-bottom: 1px solid #222; font-size: 0.20in; font-weight: 700 }
    .details { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 0.15in; line-height: 1 }
    .details th, .details td { height: 0.30in; border-bottom: 1px solid #bbb; padding: 0.035in 0.08in; vertical-align: middle; overflow: hidden; white-space: nowrap; text-overflow: ellipsis }
    .details th { width: 58%; text-align: left; font-weight: 400 }
    .details td { width: 42%; text-align: left; font-weight: 400; border-left: 1px solid #bbb }
    .tracking-area { min-width: 0; position: relative; border-top: 0; display: flex; align-items: center; justify-content: center; overflow: hidden }
    .tracking-label { font-size: 0.105in; font-weight: 700; color: #222 }
    .tracking-number { position: absolute; left: 0.08in; bottom: 0.05in; font-family: "Courier New", monospace; font-size: 0.085in; color: #555 }
    @media screen { body { display: flex; align-items: flex-start; justify-content: center; padding: 12px; background: #e5e7eb } .label { box-shadow: 0 2px 14px #0003 } }
  </style></head><body><main class="label" aria-label="NatEx address label">
    <aside class="logo-panel"><img src="/natex-label-logo.jpg" alt="NatEx"></aside>
    <section class="document">
      <div class="left-column">
        <section class="to-block"><h2 class="section-label">To:</h2><p class="recipient-name">${text(data.recipientName)}</p><p class="recipient-address">${text(data.recipientAddress)}</p>${data.recipientPhone ? `<p class="recipient-phone">Tel: ${text(data.recipientPhone)}</p>` : ""}</section>
        <section class="from-block"><h2 class="section-label">From:</h2><p class="sender-name">${text(data.senderName)}</p><p class="sender-address">${text(data.senderAddress)}</p>${data.senderPhone ? `<p class="sender-phone">Tel: ${text(data.senderPhone)}</p>` : ""}</section>
      </div>
      <div class="right-column">
        <section class="package-detail"><div class="package-title">Package Detail</div><table class="details"><tbody>
          ${detailRow("Weight", weightLabel(data.weightGrams))}
          ${detailRow("COD Package", data.codStatus)}
          ${detailRow("COD Amount", data.codAmountCents > 0 ? labelMoney(data.codAmountCents) : "-")}
          ${detailRow("Delivery charge", text(data.deliveryCharge))}
          ${detailRow("Total collect", data.totalCollectCents > 0 ? labelMoney(data.totalCollectCents) : "-")}
          ${detailRow("Advanced paid", advancedPaid)}
        </tbody></table></section>
        <section class="tracking-area"><span class="tracking-label">Tracking Number</span><span class="tracking-number">${text(data.awb)}</span></section>
      </div>
    </section>
  </main></body></html>`;
}
