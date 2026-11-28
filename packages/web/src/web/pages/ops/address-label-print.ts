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

function money(cents: number): string {
  return `Rs. ${(cents / 100).toFixed(2)}`;
}

function text(value: string | null | undefined, fallback = "—"): string {
  const trimmed = value?.trim();
  return escapeHtml(trimmed || fallback);
}

/** Print-ready label matching the NatEx sample: prominent To/From blocks, charge table, and sticker space. */
export function renderAddressLabel(data: AddressLabelData): string {
  const row = (label: string, value: string) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>NatEx address label ${escapeHtml(data.awb)}</title><style>
    @page { size: 100mm 150mm; margin: 0 }
    * { box-sizing: border-box }
    body { margin: 0; background: #fff; color: #111; font: 11px/1.3 Arial, Helvetica, sans-serif }
    .label { width: 100mm; min-height: 150mm; padding: 7mm; position: relative; display: flex; flex-direction: column; gap: 4mm; border: 1px solid #111 }
    .brand { display: flex; align-items: center; gap: 4mm; border-bottom: 2px solid #111; padding-bottom: 3mm }
    .brand img { width: 31mm; max-height: 13mm; object-fit: contain; object-position: left center }
    .brand-copy { margin-left: auto; text-align: right; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase }
    .tracking { font: 700 16px/1.1 "Courier New", monospace; letter-spacing: .08em; overflow-wrap: anywhere }
    .address-box { border: 1.5px solid #111; padding: 3mm; min-height: 29mm }
    .address-box h2 { margin: 0 0 2mm; font-size: 10px; letter-spacing: .14em; text-transform: uppercase }
    .address-box .name { font-size: 16px; font-weight: 800; margin-bottom: 1mm }
    .address-box .phone { font-weight: 700; margin-top: 1.5mm }
    .from-box { border: 1px solid #555; padding: 2.5mm; min-height: 21mm }
    .from-box h2 { margin: 0 0 1.5mm; font-size: 9px; letter-spacing: .14em; text-transform: uppercase }
    .from-box .name { font-size: 12px; font-weight: 700 }
    .details { border-collapse: collapse; width: 100%; margin-top: 1mm; font-size: 10px }
    .details th, .details td { border-bottom: 1px solid #bbb; padding: 1.7mm 0; vertical-align: top }
    .details th { width: 45%; text-align: left; font-weight: 700 }
    .details td { text-align: right; font-family: "Courier New", monospace; overflow-wrap: anywhere }
    .details .strong th, .details .strong td { border-bottom: 2px solid #111; font-size: 12px; font-weight: 800 }
    .footer { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 5mm; min-height: 18mm; border-top: 1px solid #111; padding-top: 3mm }
    .footer-note { font-size: 8px; color: #444; max-width: 44mm }
    .sticker { min-width: 30mm; text-align: right; font-size: 9px; font-weight: 700; color: #333 }
    @media screen { body { padding: 10px; background: #e5e7eb } .label { margin: 0 auto; box-shadow: 0 2px 12px #0002 } }
  </style></head><body><main class="label" aria-label="NatEx address label">
    <header class="brand"><img src="/natex-label-logo.jpg" alt="NatEx"><div class="brand-copy">Address label<br><span class="tracking">${text(data.awb)}</span></div></header>
    <section class="address-box"><h2>To</h2><div class="name">${text(data.recipientName)}</div><div>${text(data.recipientAddress)}</div><div class="phone">Tel: ${text(data.recipientPhone)}</div></section>
    <section class="from-box"><h2>From</h2><div class="name">${text(data.senderName)}</div><div>${text(data.senderAddress)}</div>${data.senderPhone ? `<div>Tel: ${text(data.senderPhone)}</div>` : ""}</section>
    <table class="details"><tbody>
      ${row("Tracking number", text(data.awb))}
      ${row("Weight", `${data.weightGrams} g`)}
      ${row("COD package", text(data.codStatus))}
      ${row("COD amount", money(data.codAmountCents))}
      ${row("Delivery charge", text(data.deliveryCharge))}
      ${row("Advanced paid", money(data.advancedPaidCents))}
      ${row("Total collect", money(data.totalCollectCents))}
      ${data.description ? row("Contents", text(data.description)) : ""}
    </tbody></table>
    <footer class="footer"><div class="footer-note">Handle with care. Keep this label attached to the parcel.</div><div class="sticker">Tracking label</div></footer>
  </main></body></html>`;
}
