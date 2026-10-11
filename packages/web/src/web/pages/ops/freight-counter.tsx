import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Printer, RotateCcw, Search } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { kgToGrams, rupeesToCents } from "@/lib/csv";
import { addressPartsFromLegacy, formatAddress, isCompleteAddress, EMPTY_ADDRESS, provinceForDistrict, type AddressParts } from "@/lib/address";
import { money } from "@/lib/format";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AddressFields } from "@/components/natex/address-fields";
import { useAuth } from "@/components/auth-provider";
import { Dialog } from "@/components/ui/dialog";

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
type BranchOption = { id: string; name: string; type?: string; address?: string; counterRateCardId?: string | null };

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
  const homeBranch = useQuery({
    ...orpc.identity.myBranch.queryOptions(),
    enabled: !canChooseBranch && Boolean(session?.user.branchId),
    staleTime: 60_000,
  });
  const [form, setForm] = React.useState<FormState>(() => empty(session?.user.branchId ?? ""));
  const [booking, setBooking] = React.useState<Booking | null>(null);
  const [activeTab, setActiveTab] = React.useState<CounterTab>("booking");
  const [historyTerm, setHistoryTerm] = React.useState("");
  const [historySearch, setHistorySearch] = React.useState("");
  const [selectedHistoryId, setSelectedHistoryId] = React.useState<string | null>(null);
  const branches: BranchOption[] = canChooseBranch
    ? branchOptions.data ?? []
    : homeBranch.data
      ? [homeBranch.data]
      : [];
  const selectedBranch = branches.find((branch) => branch.id === form.branchId) ?? null;
  const originParts = addressPartsFromLegacy(selectedBranch?.address);
  const originDistrict = originParts.district;
  const originProvince = provinceForDistrict(originDistrict);

  React.useEffect(() => {
    if (!form.branchId && session?.user.branchId) {
      setForm((previous) => ({ ...previous, branchId: session.user.branchId }));
    }
  }, [form.branchId, session?.user.branchId]);

  React.useEffect(() => {
    if (!originDistrict || !originProvince) return;
    setForm((previous) => previous.branchId === form.branchId
      ? { ...previous, senderAddress: { ...previous.senderAddress, district: originDistrict, province: originProvince } }
      : previous);
  }, [form.branchId, originDistrict, originProvince]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setHistorySearch(historyTerm.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [historyTerm]);

  const set = <K extends keyof FormState>(key: K) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const weight = kgToGrams(form.weightKg);
  const declared = form.declaredValue.trim() ? rupeesToCents(form.declaredValue) : null;
  const declaredCents = declared && "cents" in declared ? declared.cents : null;
  const dimension = (value: string) => value.trim() ? Number(value) : null;
  const lengthCm = dimension(form.lengthCm);
  const widthCm = dimension(form.widthCm);
  const heightCm = dimension(form.heightCm);
  const dimensionsValid = [lengthCm, widthCm, heightCm].every((value) => value === null || (Number.isSafeInteger(value) && value > 0));
  const destinationAddress = formatAddress(form.destAddress);
  const quoteInput = {
    branchId: form.branchId || "_",
    weightGrams: "grams" in weight ? weight.grams : 0,
    lengthCm,
    widthCm,
    heightCm,
    destinationAddress: destinationAddress || "____",
  };
  const canQuote = Boolean(form.branchId && "grams" in weight && weight.grams > 0 && dimensionsValid && isCompleteAddress(form.destAddress));
  const priceQuote = useQuery({
    ...orpc.freight.counterQuote.queryOptions({ input: quoteInput }),
    enabled: canQuote,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
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
    enabled: activeTab === "history" && (canChooseBranch || Boolean(session?.user.branchId)),
    staleTime: 15_000,
  });
  const historyRows = historyQuery.data?.rows ?? [];
  const selectedHistory = historyRows.find((row) => row.freightCharge.id === selectedHistoryId) ?? null;

  const create = useMutation({
    mutationFn: () => client.freight.counterBooking({
      branchId: form.branchId,
      rateCardVersionId: priceQuote.data?.version.id ?? "",
      awb: form.awb.trim() || null,
      weightGrams: "grams" in weight ? weight.grams : 0,
      lengthCm,
      widthCm,
      heightCm,
      description: form.description.trim(),
      declaredValueCents: declaredCents,
      senderName: form.senderName.trim(),
      senderPhone: form.senderPhone.trim(),
      senderAddress: senderAddressProvided ? formatAddress(form.senderAddress) : null,
      payer: form.payer,
      paymentMethod: form.payer === "sender" ? form.paymentMethod : undefined,
      externalReference: form.payer === "sender" && form.paymentMethod !== "cash" ? form.externalReference.trim() : null,
      consigneeName: form.consigneeName.trim(),
      consigneePhone: form.consigneePhone.trim(),
      destAddress: destinationAddress,
      destLat: null,
      destLng: null,
      destZoneId: null,
    }),
    onSuccess: (result) => {
      setBooking(result);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      if (/rate card changed/i.test(apiMessage(error, ""))) void priceQuote.refetch();
    },
  });

  const valid = Boolean(
    form.branchId && "grams" in weight && weight.grams > 0 &&
    dimensionsValid && priceQuote.data && priceQuote.data.totalCents > 0 && !priceQuote.isFetching && !priceQuote.isError &&
    (!declared || "cents" in declared) &&
    form.description.trim().length >= 3 && form.description.trim().length <= 500 &&
    (!form.awb.trim() || (completeAwbFormat && awbCheck.data?.valid && !awbCheck.isFetching && !awbCheck.isError)) &&
    form.senderName.trim().length >= 2 && form.senderPhone.replace(/\D/g, "").length >= 9 &&
    form.consigneeName.trim().length >= 2 && form.consigneePhone.replace(/\D/g, "").length >= 9 &&
    isCompleteAddress(form.destAddress) &&
    (form.payer !== "sender" || form.paymentMethod === "cash" || form.externalReference.trim().length >= 3)
  );

  const reset = () => {
    setBooking(null);
    setForm(empty(session?.user.branchId ?? form.branchId));
    create.reset();
  };
  const canPrint = activeTab === "booking" && Boolean(booking);

  return (
    <Page
      title="Customer counter booking"
      description="Book walk-in customer parcels without a dummy merchant. Courier payment is separate from COD; the receiver is SMS-notified with the AWB and tracking link."
      actions={canPrint ? <Button size="sm" variant="outline" onClick={() => window.print()}><Printer aria-hidden />Print original document</Button> : null}
    >
      <div role="tablist" aria-label="Customer counter booking sections" className="mb-5 flex flex-wrap gap-2 border-b border-border pb-3">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "booking"}
          className={`rounded-md border px-4 py-2 text-sm font-medium ${activeTab === "booking" ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}
          onClick={() => { setSelectedHistoryId(null); setActiveTab("booking"); }}
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
                  <div className="sm:col-span-2">
                    <AddressFields title="Sender address (optional)" value={form.senderAddress} required={false} onChange={(senderAddress) => setForm((previous) => ({ ...previous, senderAddress }))} />
                    {originDistrict ? <p className="mt-1 text-[11px] text-muted-foreground">District is prefilled from {selectedBranch?.name}'s saved origin address ({originDistrict}).</p> : null}
                  </div>
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
              <Card title="Courier Payment & Receipt" description="The charge is calculated from this location's approved rate card. The payer determines when it is collected.">
                <div className="space-y-4">
                  <Field
                    label="Courier charge (rate-card price)"
                    error={priceQuote.error ? apiMessage(priceQuote.error, "Could not calculate the Counter price.") : null}
                    hint={priceQuote.data ? `${priceQuote.data.rateCard.code} v${priceQuote.data.version.version} · ${priceQuote.data.bandLabel} · chargeable ${priceQuote.data.roundedGrams} g` : undefined}
                  >
                    <Input value={priceQuote.data ? money(priceQuote.data.totalCents) : priceQuote.isFetching ? "Calculating…" : "Enter parcel and delivery details"} readOnly />
                  </Field>
                  {priceQuote.data ? (
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px]">
                      {priceQuote.data.lines.map((line) => <p key={line.code} className="flex justify-between gap-3"><span>{line.label}</span><span className="font-mono">{money(line.amountCents)}</span></p>)}
                      <p className="mt-1 border-t border-border pt-1 text-muted-foreground">{priceQuote.data.originDistrict} → {priceQuote.data.destinationDistrict}</p>
                    </div>
                  ) : null}
                  {!canQuote && selectedBranch && !selectedBranch.counterRateCardId ? <p className="text-xs text-status-warn">Ask an Admin to assign an approved Counter rate card to this branch in Administration → Branches.</p> : null}
                  {!canQuote && (lengthCm !== null || widthCm !== null || heightCm !== null) && !dimensionsValid ? <p className="text-xs text-status-warn">Dimensions must be positive whole centimetres.</p> : null}
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
          {historyQuery.data && historyQuery.data.total > historyRows.length ? (
            <p className="text-xs text-muted-foreground">Showing the latest {historyRows.length} of {historyQuery.data.total}. Narrow your search to find older bookings.</p>
          ) : null}
        </section>
      )}
      <Dialog
        open={activeTab === "history" && Boolean(selectedHistory)}
        onOpenChange={(open) => { if (!open) setSelectedHistoryId(null); }}
        title={selectedHistory ? `Duplicate ${selectedHistory.paidReceipt ? "payment receipt" : "charge notice"}` : "Counter document"}
        description="This reprint is marked DUPLICATE. The original charge and payment history remain unchanged."
        footer={selectedHistory ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setSelectedHistoryId(null)}>Close</Button>
            <Button onClick={() => window.print()}><Printer aria-hidden />Print duplicate</Button>
          </div>
        ) : null}
      >
        {selectedHistory ? <FreightReceipt booking={selectedHistory} duplicate /> : null}
      </Dialog>
    </Page>
  );
}

type ReceiptPricingSnapshot = {
  rateCard?: { code?: string; name?: string };
  version?: { version?: number };
  originDistrict?: string;
  destinationDistrict?: string;
  bandLabel?: string;
  actualGrams?: number;
  roundedGrams?: number;
  lines?: Array<{ code: string; label: string; amountCents: number; detail?: string }>;
};

function FreightReceipt({ booking, duplicate = false }: { booking: ReceiptRecord; duplicate?: boolean }) {
  const charge = booking.freightCharge;
  const receipt = booking.paidReceipt;
  let pricing: ReceiptPricingSnapshot | null = null;
  try {
    pricing = charge.pricingSnapshotJson ? JSON.parse(charge.pricingSnapshotJson) as ReceiptPricingSnapshot : null;
  } catch {
    pricing = null;
  }
  return (
    <>
      <style>{`@page{size:A6 portrait;margin:4mm}@media print{body *{visibility:hidden!important}.retail-freight-slip,.retail-freight-slip *{visibility:visible!important}.retail-freight-slip{display:block!important;position:fixed!important;left:0!important;top:0!important;width:97mm!important;height:140mm!important;max-width:none!important;box-sizing:border-box!important;overflow:hidden!important;background:#fff!important;color:#111!important;padding:5mm!important;font:7pt/1.25 Arial,sans-serif!important;border:0!important;border-radius:0!important;box-shadow:none!important}.retail-freight-slip table{width:100%;border-collapse:collapse}.retail-freight-slip td{padding:1.4mm 0;border-bottom:0.2mm solid #ddd;vertical-align:top}.retail-freight-slip .right{text-align:right;font-family:monospace;overflow-wrap:anywhere}.retail-freight-slip img{max-width:32mm;max-height:13mm;object-fit:contain}.retail-freight-slip .receipt-title{font-size:10pt}.retail-freight-slip .receipt-subtitle{font-size:6pt}.retail-freight-slip .receipt-content{position:relative;z-index:2}.retail-freight-slip .receipt-watermark{position:absolute;z-index:1;top:47%;left:7%;transform:rotate(-27deg);font-size:27pt;font-weight:800;letter-spacing:2mm;color:rgba(160,0,0,.12);white-space:nowrap}}`}</style>
      <style>{`@media print{[role="dialog"]{position:static!important;inset:auto!important;left:auto!important;top:auto!important;transform:none!important;translate:none!important;width:auto!important;max-width:none!important;max-height:none!important;overflow:visible!important;margin:0!important;padding:0!important;border:0!important;box-shadow:none!important}.retail-freight-slip .receipt-logo{max-width:28mm!important;max-height:9mm!important;margin:0 0 1mm!important}.retail-freight-slip .receipt-title{font-size:8pt!important;line-height:1.05!important;margin:0!important}}`}</style>
      <section className="retail-freight-slip relative max-w-3xl rounded-lg border border-border bg-card p-6" aria-label={`${duplicate ? "Duplicate " : ""}customer courier payment receipt or charge notice`}>
        {duplicate ? <div className="receipt-watermark pointer-events-none absolute left-1/4 top-1/2 -rotate-12 text-4xl font-black tracking-[0.3em] text-red-700/15">DUPLICATE</div> : null}
        <div className="receipt-content">
          <header className="flex items-start justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0">
              <img src="/natex-logo.png" alt="NatEx" className="receipt-logo mb-0.5 h-7 max-w-28 object-contain object-left brightness-0" />
              <h2 className="receipt-title text-xs font-bold">Courier Payment & {receipt ? "Receipt" : "Charge Notice"}</h2>
              <p className="receipt-subtitle mt-0.5 text-[10px] text-muted-foreground">Customer counter booking</p>
            </div>
            <div className="text-right"><p className="font-mono text-xs font-semibold">{receipt?.code ?? charge.code}</p><p className="text-[10px]">{receipt ? "Payment received" : "Courier charges due at delivery"}</p></div>
          </header>
          <div className="grid grid-cols-2 gap-3 py-3 text-[11px]">
            <div className="min-w-0"><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p><p className="break-words">{charge.senderAddress ?? ""}</p></div>
            <div className="min-w-0"><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p><p className="break-words">{charge.destinationAddress}</p></div>
          </div>
          <table className="w-full text-[11px]"><tbody>
            <tr><td>AWB / Tracking number</td><td className="right">{charge.awb}</td></tr>
            <tr><td>Booked at</td><td className="right">{charge.branchName}</td></tr>
            {booking.parcel?.description ? <tr><td>Parcel contents</td><td className="right">{booking.parcel.description}</td></tr> : null}
            <tr><td>Declared value</td><td className="right">{booking.parcel?.declaredValueCents == null ? "Not declared" : money(booking.parcel.declaredValueCents)}</td></tr>
            {pricing ? <tr><td>Rate card</td><td className="right">{pricing.rateCard?.code} · v{pricing.version?.version}</td></tr> : null}
            {pricing ? <tr><td>Price band / weight</td><td className="right">{pricing.bandLabel} · {pricing.roundedGrams} g</td></tr> : null}
            {pricing?.lines?.map((line) => <tr key={line.code}><td>{line.label}</td><td className="right">{money(line.amountCents)}</td></tr>)}
            {pricing?.originDistrict && pricing.destinationDistrict ? <tr><td>Districts</td><td className="right">{pricing.originDistrict} → {pricing.destinationDistrict}</td></tr> : null}
            <tr><th scope="row" className="text-left font-semibold">Courier charge</th><td className="right"><strong>{money(charge.amountCents)}</strong></td></tr>
            <tr><td>Courier payer</td><td className="right">{charge.payer === "sender" ? "Sender — paid at counter" : receipt ? "Recipient — paid at delivery" : "Recipient — due at delivery"}</td></tr>
            <tr><td>Payment method</td><td className="right">{receipt ? receipt.paymentMethod.replaceAll("_", " ") : "Pay Rider at delivery"}</td></tr>
            {receipt?.externalReference ? <tr><td>Payment reference</td><td className="right">{receipt.externalReference}</td></tr> : null}
            <tr><td>COD</td><td className="right">Rs. 0.00</td></tr>
          </tbody></table>
          <p className="mt-3 border-t border-border pt-2 text-[10px] text-muted-foreground">{duplicate ? "DUPLICATE COPY · " : ""}{receipt ? "Keep this payment receipt for your records." : "Charge notice only; recipient-paid courier charges are due to NatEx at delivery."} Courier payment is separate from COD. This document is not a VAT tax invoice.</p>
        </div>
      </section>
    </>
  );
}
