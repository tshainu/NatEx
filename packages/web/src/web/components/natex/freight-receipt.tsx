import { money } from "@/lib/format";
import {
  receiptHeaderMetadata,
  THERMAL_RECEIPT_PRINT_CSS,
  type ReceiptBranchMetadata,
  type ReceiptContactMetadata,
} from "./receipt-print-metadata";

export type ReceiptRecord = {
  freightCharge: {
    branchName: string;
    senderName: string;
    senderPhone: string;
    senderAddress: string | null;
    recipientName: string;
    recipientPhone: string;
    destinationAddress: string;
    awb: string;
    code: string;
    amountCents: number;
    payer: string;
    pricingSnapshotJson: string | null;
  };
  paidReceipt: {
    code: string;
    paymentMethod: string;
    externalReference: string | null;
  } | null;
  parcel?: { description: string | null; declaredValueCents: number | null } | null;
};

type ReceiptPricingSnapshot = {
  rateCard?: { code?: string; name?: string };
  version?: { version?: number };
  originDistrict?: string;
  destinationDistrict?: string;
  bandLabel?: string;
  roundedGrams?: number;
  totalCents?: number;
  discountCents?: number;
  cashReceivedCents?: number | null;
  changeCents?: number | null;
  lines?: Array<{ code: string; label: string; amountCents: number; detail?: string }>;
};

export interface FreightReceiptProps {
  booking: ReceiptRecord;
  duplicate?: boolean;
  branch?: ReceiptBranchMetadata | null;
  /** Optional company website/phone returned by settings.receiptContact. */
  receiptContact?: ReceiptContactMetadata | null;
}

/**
 * Existing exported print interface remains booking + duplicate compatible;
 * branch metadata is additive and optional for historical rows.
 */
export function FreightReceipt({ booking, duplicate = false, branch, receiptContact }: FreightReceiptProps) {
  const charge = booking.freightCharge;
  const receipt = booking.paidReceipt;
  const header = receiptHeaderMetadata(branch ?? { name: charge.branchName }, receiptContact);
  let pricing: ReceiptPricingSnapshot | null = null;
  try {
    pricing = charge.pricingSnapshotJson ? JSON.parse(charge.pricingSnapshotJson) as ReceiptPricingSnapshot : null;
  } catch {
    pricing = null;
  }
  const discountCents = pricing?.discountCents ?? 0;

  return (
    <>
      <style>{THERMAL_RECEIPT_PRINT_CSS}</style>
      <section
        className="retail-freight-slip relative max-w-3xl rounded-lg border border-border bg-card p-6"
        aria-label={`${duplicate ? "Duplicate " : ""}customer courier payment receipt or charge notice`}
      >
        {duplicate ? <div className="receipt-watermark pointer-events-none absolute left-1/4 top-1/2 -rotate-12 text-4xl font-black tracking-[0.3em] text-red-700/15">DUPLICATE</div> : null}
        <div className="receipt-content">
          <header className="receipt-header border-b border-border pb-3">
            <img src="/natex-logo.png" alt="NatEx" className="receipt-logo mb-0.5 h-7 max-w-28 object-contain brightness-0" />
            <h2 className="receipt-title text-xs font-bold">Courier Payment &amp; {receipt ? "Receipt" : "Charge Notice"}</h2>
            <p className="receipt-subtitle mt-0.5 text-[10px] text-muted-foreground">Customer counter booking</p>
            <div className="receipt-contact mt-1 text-[10px] text-muted-foreground">
              <p>{header.branchName}</p>
              <p>{header.branchAddress}</p>
              <p>Branch phone: {header.branchPhone}</p>
              <p>Web: {header.website} · Contact: {header.companyPhone}</p>
            </div>
            <div className="receipt-code mt-1 flex items-center justify-between gap-3 text-left">
              <p className="font-mono text-xs font-semibold">{receipt?.code ?? charge.code}</p>
              <p className="text-[10px]">{receipt ? "Payment received" : "Courier charges due at delivery"}</p>
            </div>
          </header>
          <div className="grid grid-cols-2 gap-3 py-3 text-[11px]">
            <div className="min-w-0"><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p><p className="break-words">{charge.senderAddress ?? ""}</p></div>
            <div className="min-w-0"><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p><p className="break-words">{charge.destinationAddress}</p></div>
          </div>
          <table className="w-full text-[11px]"><tbody>
            <tr><td>Tracking number</td><td className="right">{charge.awb}</td></tr>
            <tr><td>Booked at</td><td className="right">{charge.branchName}</td></tr>
            {booking.parcel?.description ? <tr><td>Parcel contents</td><td className="right">{booking.parcel.description}</td></tr> : null}
            <tr><td>Declared value</td><td className="right">{booking.parcel?.declaredValueCents == null ? "Not declared" : money(booking.parcel.declaredValueCents)}</td></tr>
            {pricing ? <tr><td>Rate card</td><td className="right">{pricing.rateCard?.code} · v{pricing.version?.version}</td></tr> : null}
            {pricing ? <tr><td>Price band / weight</td><td className="right">{pricing.bandLabel} · {pricing.roundedGrams} g</td></tr> : null}
            {pricing?.lines?.map((line) => <tr key={line.code}><td>{line.label}</td><td className="right">{money(line.amountCents)}</td></tr>)}
            {pricing?.originDistrict && pricing.destinationDistrict ? <tr><td>Districts</td><td className="right">{pricing.originDistrict} → {pricing.destinationDistrict}</td></tr> : null}
            {discountCents > 0 ? (
              <>
                <tr><td>Rate-card courier charge</td><td className="right">{money(pricing?.totalCents ?? charge.amountCents + discountCents)}</td></tr>
                <tr><td>Discount</td><td className="right">−{money(discountCents)}</td></tr>
              </>
            ) : null}
            <tr><th scope="row" className="text-left font-semibold">{discountCents > 0 ? "Courier charge after discount" : "Courier charge"}</th><td className="right"><strong>{money(charge.amountCents)}</strong></td></tr>
            <tr><td>Courier payer</td><td className="right">{charge.payer === "sender" ? "Sender — paid at counter" : receipt ? "Recipient — paid at delivery" : "Recipient — due at delivery"}</td></tr>
            <tr><td>Payment method</td><td className="right">{receipt ? receipt.paymentMethod.replaceAll("_", " ") : "Pay Rider at delivery"}</td></tr>
            {typeof pricing?.cashReceivedCents === "number" ? <tr><td>Cash received</td><td className="right">{money(pricing.cashReceivedCents)}</td></tr> : null}
            {typeof pricing?.cashReceivedCents === "number" ? <tr><td>Change returned</td><td className="right">{money(pricing.changeCents ?? 0)}</td></tr> : null}
            {receipt?.externalReference ? <tr><td>Payment reference</td><td className="right">{receipt.externalReference}</td></tr> : null}
            <tr><td>COD</td><td className="right">Rs. 0.00</td></tr>
          </tbody></table>
          <p className="mt-3 border-t border-border pt-2 text-[10px] text-muted-foreground">{duplicate ? "DUPLICATE COPY · " : ""}{receipt ? "Keep this payment receipt for your records." : "Charge notice only; recipient-paid courier charges are due to NatEx at delivery."} Courier payment is separate from COD. This document is not a VAT tax invoice.</p>
        </div>
      </section>
    </>
  );
}
