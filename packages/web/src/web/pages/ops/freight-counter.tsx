import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Printer, RotateCcw, Search } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { kgToGrams, rupeesToCents } from "@/lib/csv";
import { formatAddress, isCompleteAddress, EMPTY_ADDRESS, type AddressParts } from "@/lib/address";
import { money } from "@/lib/format";
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
  description: string;
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
}

const empty = (branchId: string): FormState => ({
  branchId,
  awb: "",
  weightKg: "1",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  description: "",
  declaredValue: "",
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
});

type Booking = Awaited<ReturnType<typeof client.freight.counterBooking>>;
type ReceiptRecord = {
  freightCharge: Booking["freightCharge"];
  paidReceipt: Booking["paidReceipt"];
  parcel?: { description: string | null; declaredValueCents: number | null } | null;
};
type BranchOption = { id: string; name: string; type?: string };

type CounterTab = "booking" | "history";

export default function RetailFreightCounter() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const canChooseBranch = session?.user.role === "admin";
  const branchOptions = useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    enabled: canChooseBranch,
    staleTime: 5 * 60_000,
  });
  const [form, setForm] = React.useState<FormState>(() => empty(session?.user.branchId ?? ""));
  const [booking, setBooking] = React.useState<Booking | null>(null);
  const [activeTab, setActiveTab] = React.useState<CounterTab>("booking");
  const [historyTerm, setHistoryTerm] = React.useState("");
  const [historySearch, setHistorySearch] = React.useState("");
  const [selectedHistoryId, setSelectedHistoryId] = React.useState<string | null>(null);
  const branches: BranchOption[] = canChooseBranch
    ? branchOptions.data ?? []
    : session
      ? [{ id: session.user.branchId, name: session.user.branchName }]
      : [];

  React.useEffect(() => {
    if (!form.branchId && session?.user.branchId) {
      setForm((previous) => ({ ...previous, branchId: session.user.branchId }));
    }
  }, [form.branchId, session?.user.branchId]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setHistorySearch(historyTerm.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [historyTerm]);

  const set = <K extends keyof FormState>(key: K) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const weight = kgToGrams(form.weightKg);
  const freight = rupeesToCents(form.freight);
  const declared = form.declaredValue.trim() ? rupeesToCents(form.declaredValue) : null;
  const freightCents = "cents" in freight ? freight.cents : 0;
  const declaredCents = declared && "cents" in declared ? declared.cents : null;
  const senderAddressProvided = Object.values(form.senderAddress).some((part) => part.trim().length > 0);
  const enteredAwb = form.awb.trim().toUpperCase();
  const completeAwbFormat = /^NX\d{10}$/.test(enteredAwb);
  const awbCheck = useQuery({
    ...orpc.awbBatches.checkBranch.queryOptions({
      input: { branchId: form.branchId, awb: enteredAwb || "_" },
    }),
    enabled: Boolean(form.branchId && completeAwbFormat),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const awbInlineError = form.awb.trim()
    ? !form.branchId
      ? "Select an accepting branch / hub to validate this AWB."
      : enteredAwb.length >= 12 && !completeAwbFormat
        ? "Enter a valid 12-character NX AWB (NX followed by 10 digits)."
        : awbCheck.data && !awbCheck.data.valid
          ? awbCheck.data.reason
          : awbCheck.isError
            ? "Could not verify this AWB. Check your connection and try again."
            : null
    : null;
  const awbHint = !form.awb.trim()
    ? "Optional. Enter a label to check it immediately against this branch's unused AWB stock."
    : awbCheck.isFetching
      ? "Checking branch AWB stock…"
      : awbCheck.data?.valid
        ? "Available and assigned to this branch / hub."
        : enteredAwb.length < 12
          ? "Type the full 12-character AWB; its branch allocation will be checked automatically."
          : undefined;

  const historyQuery = useQuery({
    ...orpc.freight.counterHistory.queryOptions({
      input: {
        branchId: canChooseBranch ? form.branchId || undefined : undefined,
        search: historySearch || undefined,
        page: 1,
        pageSize: 50,
      },
    }),
    enabled: activeTab === "history" && Boolean(session?.user.branchId),
    staleTime: 15_000,
  });
  const historyRows = historyQuery.data?.rows ?? [];
  const selectedHistory = historyRows.find((row) => row.freightCharge.id === selectedHistoryId) ?? null;

  const create = useMutation({
    mutationFn: () => client.freight.counterBooking({
      branchId: form.branchId,
      awb: form.awb.trim() || null,
      weightGrams: "grams" in weight ? weight.grams : 0,
      lengthCm: form.lengthCm ? Number(form.lengthCm) : null,
      widthCm: form.widthCm ? Number(form.widthCm) : null,
      heightCm: form.heightCm ? Number(form.heightCm) : null,
      description: form.description.trim(),
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
      destLat: null,
      destLng: null,
      destZoneId: null,
    }),
    onSuccess: (result) => {
      setBooking(result);
      void queryClient.invalidateQueries();
    },
  });

  const valid = Boolean(
    form.branchId && "grams" in weight && weight.grams > 0 &&
    "cents" in freight && freightCents > 0 && (!declared || "cents" in declared) &&
    form.description.trim().length >= 3 && form.description.trim().length <= 500 &&
    (!form.awb.trim() || (completeAwbFormat && awbCheck.data?.valid && !awbCheck.isFetching && !awbCheck.isError)) &&
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
  const canPrint = activeTab === "booking" ? Boolean(booking) : Boolean(selectedHistory);

  return (
    <Page
      title="Customer counter booking"
      description="Book walk-in customer parcels without a dummy merchant. Courier payment is separate from COD; the receiver is SMS-notified with the AWB and tracking link."
      actions={canPrint ? <Button size="sm" variant="outline" onClick={() => window.print()}><Printer aria-hidden />Print / reprint</Button> : null}
    >
      <div role="tablist" aria-label="Customer counter booking sections" className="mb-5 flex flex-wrap gap-2 border-b border-border pb-3">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "booking"}
          className={`rounded-md border px-4 py-2 text-sm font-medium ${activeTab === "booking" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}
          onClick={() => setActiveTab("booking")}
        >Counter booking</button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "history"}
          className={`rounded-md border px-4 py-2 text-sm font-medium ${activeTab === "history" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}
          onClick={() => setActiveTab("history")}
        >History</button>
      </div>

      {activeTab === "booking" ? (
        booking ? (
          <>
            <Card className="max-w-4xl border-status-good/40 bg-status-good/5">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-good" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">Counter parcel accepted</p>
                  <KeyValueGrid className="mt-3" columns={3}>
                    <KeyValue label="AWB" mono>{booking.parcel.awb}</KeyValue>
                    <KeyValue label="Status">{booking.parcel.status}</KeyValue>
                    <KeyValue label={booking.paidReceipt ? "Payment receipt" : "Charge notice"} mono>{booking.paidReceipt?.code ?? booking.freightCharge.code}</KeyValue>
                    <KeyValue label="Courier payment">{money(booking.freightCharge.amountCents)}</KeyValue>
                    <KeyValue label="Payer">{booking.freightCharge.payer === "sender" ? "Sender — paid at counter" : "Recipient — due at delivery"}</KeyValue>
                    <KeyValue label="COD">Rs. 0.00 — not a COD parcel</KeyValue>
                  </KeyValueGrid>
                  <p className="mt-3 text-sm text-muted-foreground">A receiver tracking SMS has been queued. Delivery status and retries are recorded by the SMS worker.</p>
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
                  <Field label="Accepting branch / hub" hint={canChooseBranch ? "Choose the accepting location." : "Only your assigned branch / hub is available."}>
                    <Select
                      value={form.branchId}
                      onChange={set("branchId")}
                      required
                      disabled={!canChooseBranch}
                    >
                      <option value="">Select branch / hub…</option>
                      {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.type ? ` · ${branch.type}` : ""}</option>)}
                    </Select>
                  </Field>
                  <Field label="Branch AWB sticker" hint={awbHint} error={awbInlineError}>
                    <Input
                      value={form.awb}
                      onChange={(event) => setForm((previous) => ({ ...previous, awb: event.target.value.toUpperCase() }))}
                      placeholder="NX1234567890"
                      className="font-mono"
                      autoCapitalize="characters"
                      aria-invalid={Boolean(awbInlineError)}
                    />
                  </Field>
                  <Field label="Parcel description (what's inside)" hint="Describe the contents for handling and delivery.">
                    <Input value={form.description} onChange={set("description")} maxLength={500} required placeholder="e.g. Clothing, documents, or household items" />
                  </Field>
                  <div className="grid grid-cols-4 gap-3">
                    <Field label="Weight (kg)" error={"error" in weight ? weight.error : null}><Input value={form.weightKg} onChange={set("weightKg")} inputMode="decimal" required /></Field>
                    <Field label="L (cm)"><Input value={form.lengthCm} onChange={set("lengthCm")} inputMode="numeric" /></Field>
                    <Field label="W (cm)"><Input value={form.widthCm} onChange={set("widthCm")} inputMode="numeric" /></Field>
                    <Field label="H (cm)"><Input value={form.heightCm} onChange={set("heightCm")} inputMode="numeric" /></Field>
                  </div>
                  <Field label="Declared value (Rs.)" hint="Optional — leave blank if no value is declared." error={declared && "error" in declared ? declared.error : null}>
                    <Input value={form.declaredValue} onChange={set("declaredValue")} inputMode="decimal" placeholder="Optional" />
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
                </div>
              </Card>
              <Card title="Courier Payment & Receipt" description="Enter the courier charge once. The payer determines when it is collected.">
                <div className="space-y-4">
                  <Field label="Courier charge (Rs.)" error={"error" in freight ? freight.error : null} hint={"cents" in freight ? `Exact amount: ${money(freight.cents)}` : undefined}>
                    <Input value={form.freight} onChange={set("freight")} inputMode="decimal" required />
                  </Field>
                  <Field label="Who pays courier charges?">
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
                      Nothing is collected at this counter. The Rider collects this separately from COD before marking delivery complete.
                    </p>
                  )}
                </div>
              </Card>
              {create.isError ? <ErrorNote>{apiMessage(create.error, "The counter booking could not be completed.")}</ErrorNote> : null}
              <div className="flex justify-end">
                <Button type="submit" disabled={!valid || create.isPending}>{create.isPending ? "Saving…" : "Accept parcel & issue payment document"}</Button>
              </div>
            </div>
          </form>
        )
      ) : (
        <section aria-label="Counter booking history" className="space-y-4">
          <Card title="Counter booking history" description="Search by AWB, sender name, or sender/receiver phone number. Select a booking to view its current charge notice or payment receipt and print it again.">
            <Field label="Search history">
              <Input value={historyTerm} onChange={(event) => { setHistoryTerm(event.target.value); setSelectedHistoryId(null); }} placeholder="AWB, sender, or receiver phone" />
            </Field>
            {canChooseBranch ? (
              <Field label="Branch / hub" hint="Admins can filter Counter bookings by location." className="mt-3">
                <Select value={form.branchId} onChange={set("branchId")}>
                  <option value="">All locations</option>
                  {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.type ? ` · ${branch.type}` : ""}</option>)}
                </Select>
              </Field>
            ) : <p className="mt-3 text-xs text-muted-foreground">Showing bookings for {session?.user.branchName ?? "your assigned branch / hub"} only.</p>}
          </Card>
          {historyQuery.isError ? <ErrorNote>{apiMessage(historyQuery.error, "Counter history could not be loaded.")}</ErrorNote> : null}
          {historyQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading Counter history…</p> : null}
          <div className="grid gap-3">
            {historyRows.map((row) => (
              <Card key={row.freightCharge.id} className="max-w-5xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold">{row.freightCharge.awb}</p>
                    <p className="mt-1 text-sm">Sender: {row.freightCharge.senderName} · Receiver: {row.freightCharge.recipientPhone}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.parcel.description || "No parcel description"} · {row.freightCharge.branchName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{row.freightCharge.payer === "sender" ? "Sender pays" : "Recipient pays"} · {money(row.freightCharge.amountCents)} · {row.dueCents <= 0 ? "Paid" : `Due ${money(row.dueCents)}`}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setSelectedHistoryId(row.freightCharge.id)}>
                    <Search aria-hidden />View receipt / notice
                  </Button>
                </div>
              </Card>
            ))}
            {!historyQuery.isLoading && historyRows.length === 0 ? <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">No Counter bookings match this search in the selected location.</p> : null}
          </div>
          {selectedHistory ? <FreightReceipt booking={selectedHistory} /> : null}
          {historyQuery.data && historyQuery.data.total > historyRows.length ? (
            <p className="text-xs text-muted-foreground">Showing the latest {historyRows.length} of {historyQuery.data.total}. Narrow your search to find older bookings.</p>
          ) : null}
        </section>
      )}
    </Page>
  );
}

function FreightReceipt({ booking }: { booking: ReceiptRecord }) {
  const charge = booking.freightCharge;
  const receipt = booking.paidReceipt;
  return (
    <>
      <style>{`@media print {body *{visibility:hidden!important}.retail-freight-slip,.retail-freight-slip *{visibility:visible!important}.retail-freight-slip{display:block!important;position:fixed;inset:0;background:white;color:#111;padding:36px;font:14px Arial,sans-serif}.retail-freight-slip table{width:100%;border-collapse:collapse}.retail-freight-slip td{padding:7px;border-bottom:1px solid #ddd}.retail-freight-slip .right{text-align:right;font-family:monospace}.retail-freight-slip img{max-width:150px;max-height:64px;object-fit:contain}}`}</style>
      <section className="retail-freight-slip max-w-3xl rounded-lg border border-border bg-card p-6" aria-label="Printable customer courier payment receipt or charge notice">
        <div className="flex items-start justify-between gap-4 border-b pb-4">
          <div>
            <img src="/natex-logo.png" alt="NatEx" className="mb-3 h-12 max-w-36 object-contain object-left brightness-0" />
            <h2 className="text-xl font-bold">Courier Payment & {receipt ? "Receipt" : "Charge Notice"}</h2>
            <p className="mt-1 text-sm text-muted-foreground">Customer counter booking</p>
          </div>
          <div className="text-right"><p className="font-mono font-semibold">{receipt?.code ?? charge.code}</p><p className="text-xs">{receipt ? "Payment received" : "Courier charges due at delivery"}</p></div>
        </div>
        <div className="grid grid-cols-2 gap-4 py-4 text-sm">
          <div><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p><p>{charge.senderAddress ?? ""}</p></div>
          <div><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p><p>{charge.destinationAddress}</p></div>
        </div>
        <table><tbody>
          <tr><td>AWB / tracking number</td><td className="right">{charge.awb}</td></tr>
          <tr><td>Booked at</td><td className="right">{charge.branchName}</td></tr>
          {booking.parcel?.description ? <tr><td>Parcel contents</td><td className="right">{booking.parcel.description}</td></tr> : null}
          <tr><td>Declared value</td><td className="right">{booking.parcel?.declaredValueCents == null ? "Not declared" : money(booking.parcel.declaredValueCents)}</td></tr>
          <tr><td>Courier charge</td><td className="right">{money(charge.amountCents)}</td></tr>
          <tr><td>Courier payer</td><td className="right">{charge.payer === "sender" ? "Sender — paid at counter" : receipt ? "Recipient — paid at delivery" : "Recipient — due at delivery"}</td></tr>
          <tr><td>Payment method</td><td className="right">{receipt ? receipt.paymentMethod.replaceAll("_", " ") : "Pay Rider at delivery"}</td></tr>
          {receipt?.externalReference ? <tr><td>Payment reference</td><td className="right">{receipt.externalReference}</td></tr> : null}
          <tr><td>COD</td><td className="right">Rs. 0.00</td></tr>
        </tbody></table>
        <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">{receipt ? "Keep this payment receipt for your records." : "This is a charge notice, not a payment receipt; recipient-paid courier charges are due to NatEx at delivery."} Courier payment is separate from COD. This document is not a VAT tax invoice.</p>
      </section>
    </>
  );
}
