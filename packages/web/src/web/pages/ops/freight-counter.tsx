import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer, RotateCcw, CheckCircle2 } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { kgToGrams, rupeesToCents } from "@/lib/csv";
import { formatAddress, isCompleteAddress, EMPTY_ADDRESS, type AddressParts } from "@/lib/address";
import { money, toE6 } from "@/lib/format";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AddressFields } from "@/components/natex/address-fields";
import { useAuth } from "@/components/auth-provider";

interface FormState {
  branchId: string;
  awb: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  declaredValue: string;
  senderName: string;
  senderPhone: string;
  senderAddress: AddressParts;
  payer: "sender" | "recipient";
  freight: string;
  paymentMethod: "cash" | "bank_transfer" | "qr" | "card";
  externalReference: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: AddressParts;
  destLat: string;
  destLng: string;
}

const empty = (branchId: string): FormState => ({
  branchId,
  awb: "",
  weightKg: "1",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  declaredValue: "0",
  senderName: "",
  senderPhone: "",
  senderAddress: { ...EMPTY_ADDRESS },
  payer: "sender",
  freight: "",
  paymentMethod: "cash",
  externalReference: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: { ...EMPTY_ADDRESS },
  destLat: "",
  destLng: "",
});

type Booking = Awaited<ReturnType<typeof client.freight.counterBooking>>;

export default function RetailFreightCounter() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const branchOptions = useQuery({ ...orpc.identity.listBranches.queryOptions(), staleTime: 5 * 60_000 });
  const [form, setForm] = React.useState<FormState>(() => empty(session?.user.branchId ?? ""));
  const [booking, setBooking] = React.useState<Booking | null>(null);
  const branches = branchOptions.data ?? [];

  React.useEffect(() => {
    if (!form.branchId && session?.user.branchId) {
      setForm((previous) => ({ ...previous, branchId: session.user.branchId }));
    }
  }, [form.branchId, session?.user.branchId]);

  const set = <K extends keyof FormState>(key: K) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const weight = kgToGrams(form.weightKg);
  const freight = rupeesToCents(form.freight);
  const declared = rupeesToCents(form.declaredValue);
  const freightCents = "cents" in freight ? freight.cents : 0;
  const declaredCents = "cents" in declared ? declared.cents : 0;
  const senderAddressProvided = Object.values(form.senderAddress).some((part) => part.trim().length > 0);
  const hasCoordinates = form.destLat.trim() !== "" && form.destLng.trim() !== "";
  const serviceability = useQuery({
    ...orpc.routing.checkServiceability.queryOptions({
      input: { lat: Number(form.destLat), lng: Number(form.destLng) },
    }),
    enabled: hasCoordinates && !Number.isNaN(Number(form.destLat)) && !Number.isNaN(Number(form.destLng)),
  });

  const create = useMutation({
    mutationFn: () => client.freight.counterBooking({
      branchId: form.branchId,
      awb: form.awb.trim() || null,
      weightGrams: "grams" in weight ? weight.grams : 0,
      lengthCm: form.lengthCm ? Number(form.lengthCm) : null,
      widthCm: form.widthCm ? Number(form.widthCm) : null,
      heightCm: form.heightCm ? Number(form.heightCm) : null,
      declaredValueCents: declaredCents,
      senderName: form.senderName.trim(),
      senderPhone: form.senderPhone.trim(),
      senderAddress: senderAddressProvided ? formatAddress(form.senderAddress) : null,
      payer: form.payer,
      freightAmountCents: freightCents,
      paymentMethod: form.payer === "sender" ? form.paymentMethod : undefined,
      externalReference: form.payer === "sender" && form.paymentMethod !== "cash" ? form.externalReference.trim() : null,
      consigneeName: form.consigneeName.trim(),
      consigneePhone: form.consigneePhone.trim(),
      destAddress: formatAddress(form.destAddress),
      destLat: hasCoordinates ? toE6(Number(form.destLat)) : null,
      destLng: hasCoordinates ? toE6(Number(form.destLng)) : null,
      destZoneId: serviceability.data?.zone?.id ?? null,
    }),
    onSuccess: (result) => {
      setBooking(result);
      void queryClient.invalidateQueries();
    },
  });

  const valid = Boolean(
    form.branchId && "grams" in weight && weight.grams > 0 &&
    "cents" in freight && freightCents > 0 && "cents" in declared &&
    form.senderName.trim().length >= 2 && form.senderPhone.replace(/\D/g, "").length >= 9 &&
    form.consigneeName.trim().length >= 2 && form.consigneePhone.replace(/\D/g, "").length >= 9 &&
    (!senderAddressProvided || isCompleteAddress(form.senderAddress)) &&
    isCompleteAddress(form.destAddress) &&
    (form.payer !== "sender" || form.paymentMethod === "cash" || form.externalReference.trim().length >= 3)
  );

  const reset = () => {
    setBooking(null);
    setForm(empty(session?.user.branchId ?? form.branchId));
    create.reset();
  };

  return (
    <Page
      title="Customer counter booking"
      description="Book a walk-in customer parcel without creating a dummy merchant account. Courier freight is recorded separately from COD; sender-paid bookings receive a payment receipt, while recipient-paid bookings are collected by the Rider at delivery."
      actions={booking ? <Button size="sm" variant="outline" onClick={() => window.print()}><Printer aria-hidden />Print / save as PDF</Button> : null}
    >
      {booking ? (
        <>
          <Card className="max-w-4xl border-status-good/40 bg-status-good/5">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-good" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold">Counter parcel accepted</p>
                <KeyValueGrid className="mt-3" columns={3}>
                  <KeyValue label="AWB" mono>{booking.parcel.awb}</KeyValue>
                  <KeyValue label="Status">{booking.parcel.status}</KeyValue>
                  <KeyValue label={booking.paidReceipt ? "Paid receipt" : "Charge notice"} mono>{booking.paidReceipt?.code ?? booking.freightCharge.code}</KeyValue>
                  <KeyValue label="Freight amount" mono>{money(booking.freightCharge.amountCents)}</KeyValue>
                  <KeyValue label="Payer">{booking.freightCharge.payer === "sender" ? "Sender — paid at counter" : "Recipient — due at delivery"}</KeyValue>
                  <KeyValue label="COD">Rs. 0.00 — not a COD parcel</KeyValue>
                </KeyValueGrid>
              </div>
            </div>
            <Button className="mt-4" size="sm" variant="outline" onClick={reset}><RotateCcw aria-hidden />Book another parcel</Button>
          </Card>
          <FreightReceipt booking={booking} />
        </>
      ) : (
        <form
          className="grid max-w-6xl gap-5 xl:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); if (valid) create.mutate(); }}
        >
          <div className="space-y-5">
            <Card title="Branch & parcel">
              <div className="space-y-4">
                <Field label="Accepting branch / hub" hint="Parcel custody starts at this branch.">
                  <Select value={form.branchId} onChange={set("branchId")} required disabled={session?.user.role !== "admin"}>
                    <option value="">Select branch / hub…</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.type}</option>)}
                  </Select>
                </Field>
                <Field label="Branch AWB sticker" hint="Optional. If entered, it must be unused stock assigned to this branch/hub; otherwise the next branch label is reserved automatically.">
                  <Input value={form.awb} onChange={set("awb")} placeholder="NX1234567890" className="font-mono" autoCapitalize="characters" />
                </Field>
                <div className="grid grid-cols-4 gap-3">
                  <Field label="Weight (kg)" error={"error" in weight ? weight.error : null}><Input value={form.weightKg} onChange={set("weightKg")} inputMode="decimal" required /></Field>
                  <Field label="L (cm)"><Input value={form.lengthCm} onChange={set("lengthCm")} inputMode="numeric" /></Field>
                  <Field label="W (cm)"><Input value={form.widthCm} onChange={set("widthCm")} inputMode="numeric" /></Field>
                  <Field label="H (cm)"><Input value={form.heightCm} onChange={set("heightCm")} inputMode="numeric" /></Field>
                </div>
                <Field label="Declared value (Rs.)" error={"error" in declared ? declared.error : null}>
                  <Input value={form.declaredValue} onChange={set("declaredValue")} inputMode="decimal" />
                </Field>
              </div>
            </Card>
            <Card title="Sender">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sender name"><Input value={form.senderName} onChange={set("senderName")} required /></Field>
                <Field label="Sender phone"><Input value={form.senderPhone} onChange={set("senderPhone")} inputMode="tel" placeholder="+9477XXXXXXX" required /></Field>
                <div className="sm:col-span-2"><AddressFields title="Sender address (optional)" value={form.senderAddress} required={false} onChange={(senderAddress) => setForm((previous) => ({ ...previous, senderAddress }))} /></div>
              </div>
            </Card>
          </div>
          <div className="space-y-5">
            <Card title="Recipient & delivery">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Recipient name"><Input value={form.consigneeName} onChange={set("consigneeName")} required /></Field>
                  <Field label="Recipient phone"><Input value={form.consigneePhone} onChange={set("consigneePhone")} inputMode="tel" placeholder="+9477XXXXXXX" required /></Field>
                </div>
                <AddressFields title="Delivery address" value={form.destAddress} onChange={(destAddress) => setForm((previous) => ({ ...previous, destAddress }))} />
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Latitude (optional)"><Input value={form.destLat} onChange={set("destLat")} inputMode="decimal" placeholder="6.9271" /></Field>
                  <Field label="Longitude (optional)"><Input value={form.destLng} onChange={set("destLng")} inputMode="decimal" placeholder="79.8612" /></Field>
                </div>
                {hasCoordinates && serviceability.data ? (
                  <p className="text-[12px] text-muted-foreground">{serviceability.data.serviceable ? "Serviceable" : "Outside mapped zones"} · {serviceability.data.reason}</p>
                ) : null}
              </div>
            </Card>
            <Card title="Courier freight · not COD" description="Enter the courier charge once. The payer determines when it is collected.">
              <div className="space-y-4">
                <Field label="Courier freight (Rs.)" error={"error" in freight ? freight.error : null} hint={"cents" in freight ? `Exact amount: ${money(freight.cents)}` : undefined}>
                  <Input value={form.freight} onChange={set("freight")} inputMode="decimal" required />
                </Field>
                <Field label="Who pays courier freight?">
                  <Select value={form.payer} onChange={(event) => setForm((previous) => ({ ...previous, payer: event.target.value as FormState["payer"] }))}>
                    <option value="sender">Sender pays at counter now</option>
                    <option value="recipient">Recipient pays the Rider at delivery</option>
                  </Select>
                </Field>
                {form.payer === "sender" ? (
                  <>
                    <Field label="Payment method">
                      <Select value={form.paymentMethod} onChange={set("paymentMethod")}>
                        <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="qr">QR payment</option><option value="card">Card</option>
                      </Select>
                    </Field>
                    {form.paymentMethod !== "cash" ? <Field label="Payment reference"><Input value={form.externalReference} onChange={set("externalReference")} required placeholder="Bank / QR / card reference" /></Field> : null}
                    <Badge variant="brand">Payment receipt is created with the booking</Badge>
                  </>
                ) : (
                  <p className="rounded-md border border-status-warn/30 bg-status-warn/5 px-3 py-2 text-[12px] text-muted-foreground">
                    Nothing is collected at this counter. The amount is locked to this parcel and the Rider must collect it separately from COD before marking delivery complete.
                  </p>
                )}
              </div>
            </Card>
            {create.isError ? <ErrorNote>{apiMessage(create.error, "The counter booking could not be completed.")}</ErrorNote> : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={!valid || create.isPending}>{create.isPending ? "Saving…" : "Accept parcel &amp; issue receipt"}</Button>
            </div>
          </div>
        </form>
      )}
    </Page>
  );
}

function FreightReceipt({ booking }: { booking: Booking }) {
  const charge = booking.freightCharge;
  const receipt = booking.paidReceipt;
  return (
    <>
      <style>{`@media screen {.retail-freight-slip{display:none}} @media print {body *{visibility:hidden!important}.retail-freight-slip,.retail-freight-slip *{visibility:visible!important}.retail-freight-slip{display:block!important;position:fixed;inset:0;background:white;color:#111;padding:36px;font:14px Arial,sans-serif}.retail-freight-slip table{width:100%;border-collapse:collapse}.retail-freight-slip td{padding:7px;border-bottom:1px solid #ddd}.retail-freight-slip .right{text-align:right;font-family:monospace}}`}</style>
      <section className="retail-freight-slip max-w-3xl rounded-lg border border-border bg-card p-6" aria-label="Printable customer courier freight receipt">
        <div className="flex items-start justify-between border-b pb-4">
          <div><h2 className="text-xl font-bold">NatEx · Customer Freight {receipt ? "Payment Receipt" : "Charge Notice"}</h2><p className="mt-1 text-sm text-muted-foreground">Counter retail consignment · not merchant COD</p></div>
          <div className="text-right"><p className="font-mono font-semibold">{receipt?.code ?? charge.code}</p><p className="text-xs">{receipt ? "Payment received" : "Freight due on delivery"}</p></div>
        </div>
        <div className="grid grid-cols-2 gap-4 py-4 text-sm">
          <div><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p><p>{charge.senderAddress ?? ""}</p></div>
          <div><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p><p>{charge.destinationAddress}</p></div>
        </div>
        <table><tbody>
          <tr><td>AWB</td><td className="right">{charge.awb}</td></tr>
          <tr><td>Booked at</td><td className="right">{charge.branchName}</td></tr>
          <tr><td>Courier freight</td><td className="right">{money(charge.amountCents)}</td></tr>
          <tr><td>Freight payer</td><td className="right">{charge.payer === "sender" ? "Sender — paid now" : "Recipient — due at delivery"}</td></tr>
          <tr><td>Payment method</td><td className="right">{receipt ? receipt.paymentMethod.replaceAll("_", " ") : "Pay Rider at delivery"}</td></tr>
          {receipt?.externalReference ? <tr><td>Payment reference</td><td className="right">{receipt.externalReference}</td></tr> : null}
          <tr><td>COD</td><td className="right">Rs. 0.00</td></tr>
        </tbody></table>
        <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">{receipt ? "Keep this payment receipt for your records." : "This is a charge notice, not a payment receipt; recipient-paid courier freight is due to NatEx at delivery."} Recipient-paid courier freight is collected separately from COD. This document is not a VAT tax invoice.</p>
      </section>
    </>
  );
}
