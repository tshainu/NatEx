import { describe, expect, test } from "bun:test";
import {
  closeCounterReceiptWindow,
  openCounterReceiptWindow,
  printCounterReceiptWindow,
  renderCounterBookingReceipt,
  type CounterBookingReceiptData,
  type ReceiptPrintWindow,
} from "./counter-print";

function receipt(): CounterBookingReceiptData {
  return {
    awb: "NX1234567890",
    status: "Booked",
    branch: { name: "Mannar Hub", address: "Main <Street>", phone: null },
    receiptContact: { website: "natex.lk", companyPhone: "+94700000000" },
    originAddress: "Main <Street>",
    consigneeName: "A & B",
    consigneePhone: "+94770000000",
    destAddress: "Colombo",
    weightGrams: 1000,
    lengthCm: null,
    widthCm: null,
    heightCm: null,
    declaredValueCents: 25000,
    codAmountCents: 0,
    bookedAt: "2026-11-08T08:00:00.000Z",
  };
}

function fakePopup(): ReceiptPrintWindow & { html: string; focused: boolean; printed: boolean; closed: boolean } {
  const popup = {
    html: "",
    focused: false,
    printed: false,
    closed: false,
    document: {
      open() {},
      write(value: string) { popup.html = value; },
      close() {},
    },
    focus() { popup.focused = true; },
    print() { popup.printed = true; },
    close() { popup.closed = true; },
  };
  return popup;
}

describe("counter receipt printing", () => {
  test("opens a popup through the supplied browser function", () => {
    const popup = fakePopup();
    const calls: string[][] = [];
    const opened = openCounterReceiptWindow((url, target, features) => {
      calls.push([url ?? "", target ?? "", features ?? ""]);
      return popup;
    });

    expect(opened).toBe(popup);
    expect(calls).toEqual([["", "_blank", "popup,width=420,height=720"]]);
  });

  test("reports a blocked popup without throwing", () => {
    expect(openCounterReceiptWindow(() => null)).toBeNull();
    expect(openCounterReceiptWindow(() => { throw new Error("blocked"); })).toBeNull();
  });

  test("waits for the logo before printing in a browser popup", async () => {
    const popup = fakePopup();
    let loaded: (() => void) | undefined;
    const image = {
      complete: false,
      naturalWidth: 0,
      addEventListener(event: string, handler: () => void) { if (event === "load") loaded = handler; },
    } as unknown as HTMLImageElement;
    (popup.document as ReceiptPrintWindow["document"]).images = [image];
    expect(printCounterReceiptWindow(popup, "receipt")).toBe(true);
    expect(popup.printed).toBe(false);
    loaded?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(popup.printed).toBe(true);
  });

  test("writes and prints a receipt, with escaped values and 80 mm rules", () => {
    const popup = fakePopup();
    expect(printCounterReceiptWindow(popup, renderCounterBookingReceipt(receipt()))).toBe(true);
    expect(popup.focused).toBe(true);
    expect(popup.printed).toBe(true);
    expect(popup.html).toContain("width: 80mm");
    expect(popup.html).toContain("Main &lt;Street&gt;");
    expect(popup.html).toContain("A &amp; B");
    expect(popup.html).toContain("natex.lk");
    expect(popup.html).toContain("+94700000000");
  });

  test("returns false for a missing/closed popup and closes safely", () => {
    expect(printCounterReceiptWindow(null, "receipt")).toBe(false);
    const popup = fakePopup();
    popup.closed = true;
    expect(printCounterReceiptWindow(popup, "receipt")).toBe(false);
    closeCounterReceiptWindow(null);
    closeCounterReceiptWindow(popup);
    expect(popup.closed).toBe(true);
  });

  test("returns false when the browser print call fails", () => {
    const popup = fakePopup();
    popup.print = () => { throw new Error("printer unavailable"); };
    expect(printCounterReceiptWindow(popup, "receipt")).toBe(false);
  });
});
