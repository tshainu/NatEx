import { renderToStaticMarkup } from "react-dom/server";
import { FreightReceipt, type FreightReceiptProps } from "@/components/natex/freight-receipt";

/** The popup and the on-screen document share the same receipt data and renderer. */
export function renderFreightReceiptDocument(props: FreightReceiptProps): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>NatEx counter receipt</title><style>
    body { margin: 0; background: white; color: #111; font: 12px/1.25 Arial, sans-serif }
    .retail-freight-slip { box-sizing: border-box; width: 80mm; padding: 4mm }
    .receipt-header { text-align: center }
    .receipt-logo { display: block; max-width: 28mm; max-height: 9mm; margin: 0 auto 1mm; filter: brightness(0) }
    table { width: 100%; border-collapse: collapse } td { padding: 1mm 0; vertical-align: top }
    .right { text-align: right; overflow-wrap: anywhere }
    .grid-cols-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 2mm }
    p, h2 { margin: 1mm 0 } .receipt-watermark { opacity: .2 }
  </style></head><body>${renderToStaticMarkup(<FreightReceipt {...props} />)}</body></html>`;
}
