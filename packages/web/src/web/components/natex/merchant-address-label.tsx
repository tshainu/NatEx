import * as React from "react";
import { createPortal } from "react-dom";
import JsBarcode from "jsbarcode";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface MerchantAddressLabelProps {
  awb: string;
  fromName: string;
  fromAddress: string;
  fromPhone?: string | null;
  toName: string;
  toAddress: string;
  toPhone?: string | null;
  disabled?: boolean;
  buttonLabel?: string;
}

export function MerchantAddressLabel({
  awb,
  fromName,
  fromAddress,
  fromPhone,
  toName,
  toAddress,
  toPhone,
  disabled = false,
  buttonLabel = "Print address label",
}: MerchantAddressLabelProps) {
  const labelRef = React.useRef<HTMLDivElement>(null);
  const barcodeRef = React.useRef<SVGSVGElement>(null);
  const normalizedAwb = awb.trim().toUpperCase();
  const validAwb = /^NX\d{10}$/.test(normalizedAwb);

  React.useEffect(() => {
    if (!barcodeRef.current || !validAwb) return;
    try {
      JsBarcode(barcodeRef.current, normalizedAwb, {
        format: "CODE128",
        width: 1.75,
        height: 38,
        margin: 0,
        displayValue: false,
        lineColor: "#000000",
        background: "#ffffff",
      });
    } catch {
      barcodeRef.current.replaceChildren();
    }
  }, [normalizedAwb, validAwb]);

  const printLabel = () => {
    if (!validAwb || disabled || !labelRef.current) return;
    document.querySelectorAll<HTMLElement>("[data-natex-label-print-active]").forEach((element) => {
      element.removeAttribute("data-natex-label-print-active");
    });
    labelRef.current.setAttribute("data-natex-label-print-active", "true");
    document.body.dataset.natexLabelPrint = "true";

    const cleanup = () => {
      window.removeEventListener("afterprint", cleanup);
      if (document.body.dataset.natexLabelPrint === "true") {
        delete document.body.dataset.natexLabelPrint;
      }
      labelRef.current?.removeAttribute("data-natex-label-print-active");
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 60_000);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()));
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); printLabel(); }} disabled={disabled || !validAwb}>
        <Printer className="size-4" aria-hidden />
        {buttonLabel}
      </Button>
      {createPortal(<div ref={labelRef} className="natex-merchant-label-print" aria-hidden="true">
        <header className="natex-merchant-label-print__from">
          <p className="natex-merchant-label-print__eyebrow">FROM</p>
          <p className="natex-merchant-label-print__name">{fromName || "Merchant"}</p>
          <p>{fromAddress || "Pickup address on file"}</p>
          {fromPhone ? <p>Tel: {fromPhone}</p> : null}
        </header>
        <div className="natex-merchant-label-print__rule" />
        <section className="natex-merchant-label-print__to">
          <p className="natex-merchant-label-print__eyebrow">DELIVER TO</p>
          <p className="natex-merchant-label-print__name">{toName || "—"}</p>
          {toPhone ? <p>Tel: {toPhone}</p> : null}
          <p className="natex-merchant-label-print__address">{toAddress || "—"}</p>
        </section>
        <footer className="natex-merchant-label-print__tracking">
          <p className="natex-merchant-label-print__eyebrow">TRACKING NUMBER</p>
          <p className="natex-merchant-label-print__awb">{normalizedAwb}</p>
          <svg ref={barcodeRef} className="natex-merchant-label-print__barcode" />
        </footer>
      </div>, document.body)}
    </>
  );
}
