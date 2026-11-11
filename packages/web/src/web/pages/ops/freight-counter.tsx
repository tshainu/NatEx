import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Printer, RotateCcw, Search } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { chargeableWeightGrams, DEFAULT_BOOKING_WEIGHT_LIMIT_GRAMS, kgToGrams, kilogramsLabel, rupeesToCents } from "@/lib/csv";
import { addressPartsFromLegacy, formatAddress, isCompleteAddress, EMPTY_ADDRESS, provinceForDistrict, type AddressParts } from "@/lib/address";
import { colomboToday, money } from "@/lib/format";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AddressFields } from "@/components/natex/address-fields";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";
import { Dialog } from "@/components/ui/dialog";
import { FreightReceipt } from "@/components/natex/freight-receipt";
import { renderFreightReceiptDocument } from "./freight-receipt-print";
import { openCounterReceiptWindow, closeCounterReceiptWindow, printCounterReceiptWindow, type ReceiptPrintWindow } from "./counter-print";
import { counterHistoryDateRange, type CounterHistoryDatePreset } from "./counter-history-date";

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
  discount: string;
  cashReceived: string;
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
  discount: "",
  cashReceived: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: { ...EMPTY_ADDRESS },
});

type Booking = Awaited<ReturnType<typeof client.freight.counterBooking>>;
type CounterHistoryRow = Awaited<ReturnType<typeof client.freight.counterHistory>>["rows"][number];
type BranchOption = { id: string; name: string; type?: string; address?: string; phone?: string | null; counterRateCardId?: string | null };

type CounterTab = "booking" | "history";
type HistorySortKey = "booked" | "awb" | "sender" | "receiver" | "item" | "branch" | "payer" | "charge" | "due";
type HistorySort = { key: HistorySortKey; direction: "asc" | "desc" };

function sortCounterHistory(rows: CounterHistoryRow[], sort: HistorySort): CounterHistoryRow[] {
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const value = (row: CounterHistoryRow): number | string => {
    switch (sort.key) {
      case "booked": return new Date(row.freightCharge.createdAt).getTime();
      case "awb": return row.freightCharge.awb;
      case "sender": return row.freightCharge.senderName;
      case "receiver": return row.freightCharge.recipientPhone;
      case "item": return row.parcel.description || "";
      case "branch": return row.freightCharge.branchName;
      case "payer": return row.freightCharge.payer === "sender" ? "Sender" : "Recipient";
      case "charge": return row.freightCharge.amountCents;
      case "due": return row.dueCents;
    }
  };
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const compared = typeof a === "number" && typeof b === "number"
      ? a - b
      : collator.compare(String(a), String(b));
    return compared === 0 ? collator.compare(left.freightCharge.awb, right.freightCharge.awb) : compared * multiplier;
  });
}

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
  const receiptContact = useQuery(orpc.settings.receiptContact.queryOptions());
  const [form, setForm] = React.useState<FormState>(() => empty(session?.user.branchId ?? ""));
  const [booking, setBooking] = React.useState<Booking | null>(null);
  const [activeTab, setActiveTab] = React.useState<CounterTab>("booking");
  const [historyTerm, setHistoryTerm] = React.useState("");
  const [historySearch, setHistorySearch] = React.useState("");
  const [historyBranchId, setHistoryBranchId] = React.useState("");
  const [historyDatePreset, setHistoryDatePreset] = React.useState<CounterHistoryDatePreset>("all");
  const [historyCustomStart, setHistoryCustomStart] = React.useState("");
  const [historyCustomEnd, setHistoryCustomEnd] = React.useState("");
  const [historySort, setHistorySort] = React.useState<HistorySort>({ key: "booked", direction: "desc" });
  const [selectedHistoryId, setSelectedHistoryId] = React.useState<string | null>(null);
  const [printNotice, setPrintNotice] = React.useState<string | null>(null);
  const receiptPopupRef = React.useRef<ReceiptPrintWindow | null>(null);
  const submissionInFlight = React.useRef(false);
  const bookingLimits = useQuery({
    ...orpc.settings.bookingLimits.queryOptions(),
    staleTime: 0,
    refetchInterval: 30_000,
  });
  const maxWeightGrams = bookingLimits.data?.maxChargeableWeightGrams ?? DEFAULT_BOOKING_WEIGHT_LIMIT_GRAMS;
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

  const historyDateRange = historyDatePreset === "custom"
    ? { startDate: historyCustomStart || undefined, endDate: historyCustomEnd || undefined }
    : counterHistoryDateRange(historyDatePreset, colomboToday());
  const historyCustomRangeInvalid = Boolean(historyCustomStart && historyCustomEnd && historyCustomStart > historyCustomEnd);
  const historyDateFilterReady = historyDatePreset !== "custom" || Boolean(historyCustomStart && historyCustomEnd && !historyCustomRangeInvalid);

  const set = <K extends keyof FormState>(key: K) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const weight = kgToGrams(form.weightKg, maxWeightGrams);
  const declared = form.declaredValue.trim() ? rupeesToCents(form.declaredValue) : null;
  const declaredCents = declared && "cents" in declared ? declared.cents : null;
  const dimension = (value: string) => value.trim() ? Number(value) : null;
  const lengthCm = dimension(form.lengthCm);
  const widthCm = dimension(form.widthCm);
  const heightCm = dimension(form.heightCm);
  const dimensionsValid = [lengthCm, widthCm, heightCm].every((value) => value === null || (Number.isSafeInteger(value) && value > 0));
  const chargeableWeight = "grams" in weight && dimensionsValid
    ? chargeableWeightGrams(weight.grams, lengthCm, widthCm, heightCm)
    : null;
  const weightLimitError = chargeableWeight !== null && chargeableWeight > maxWeightGrams
    ? `Chargeable weight including parcel size cannot exceed ${kilogramsLabel(maxWeightGrams)} kg.`
    : null;
  const destinationAddress = formatAddress(form.destAddress);
  const quoteInput = {
    branchId: form.branchId || "_",
    weightGrams: "grams" in weight ? weight.grams : 0,
    lengthCm,
    widthCm,
    heightCm,
    destinationAddress: destinationAddress || "____",
  };
  const canQuote = Boolean(form.branchId && "grams" in weight && weight.grams > 0 && dimensionsValid && !weightLimitError && isCompleteAddress(form.destAddress));
  const priceQuote = useQuery({
    ...orpc.freight.counterQuote.queryOptions({ input: quoteInput }),
    enabled: canQuote,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const discountResult = rupeesToCents(form.discount);
  const discountAmountCents = "cents" in discountResult ? discountResult.cents : null;
  const discountError = "error" in discountResult
    ? discountResult.error
    : priceQuote.data && discountResult.cents >= priceQuote.data.totalCents
      ? "Discount must be less than the rate-card charge."
      : null;
  const discountedChargeCents = priceQuote.data && discountAmountCents !== null
    ? Math.max(0, priceQuote.data.totalCents - discountAmountCents)
    : priceQuote.data?.totalCents ?? null;
  const cashCollectionRequired = form.payer === "sender" && form.paymentMethod === "cash";
  const cashReceivedResult = form.cashReceived.trim() ? rupeesToCents(form.cashReceived) : null;
  const cashReceivedCents = cashReceivedResult && "cents" in cashReceivedResult ? cashReceivedResult.cents : null;
  const cashShortCents = cashReceivedCents !== null && discountedChargeCents !== null
    ? Math.max(0, discountedChargeCents - cashReceivedCents)
    : null;
  const changeDueCents = cashReceivedCents !== null && discountedChargeCents !== null
    ? Math.max(0, cashReceivedCents - discountedChargeCents)
    : null;
  const cashReceivedError = !cashCollectionRequired
    ? null
    : cashReceivedResult && "error" in cashReceivedResult
      ? cashReceivedResult.error
      : cashReceivedCents === null
        ? "Enter the cash amount received."
        : cashShortCents !== null && cashShortCents > 0
          ? `Cash is short by ${money(cashShortCents)}.`
          : null;
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
      ? "Select an accepting branch / hub to validate this tracking number."
      : enteredAwb.length >= 12 && !completeAwbFormat
        ? "Enter a valid 12-character NX tracking number (NX followed by 10 digits)."
        : awbCheck.data && !awbCheck.data.valid
          ? awbCheck.data.reason
          : awbCheck.isError
            ? "Could not verify this tracking number. Check your connection and try again."
            : null
    : null;
  const awbHint = !form.awb.trim()
    ? "Optional. Enter a label to check it immediately against this branch's unused tracking number stock."
    : awbCheck.isFetching
      ? "Checking branch tracking number stock…"
      : awbCheck.data?.valid
        ? "Available and assigned to this branch / hub."
        : enteredAwb.length < 12
          ? "Type the full 12-character tracking number; its branch allocation will be checked automatically."
          : undefined;

  const historyQuery = useQuery({
    ...orpc.freight.counterHistory.queryOptions({
      input: {
        branchId: canChooseBranch ? historyBranchId || undefined : undefined,
        search: historySearch || undefined,
        startDate: historyDateRange.startDate,
        endDate: historyDateRange.endDate,
        page: 1,
        pageSize: 50,
      },
    }),
    enabled: activeTab === "history" && historyDateFilterReady && (canChooseBranch || Boolean(session?.user.branchId)),
    staleTime: 15_000,
  });
  const historyRows = React.useMemo(() => historyDateFilterReady ? historyQuery.data?.rows ?? [] : [], [historyDateFilterReady, historyQuery.data]);
  const sortedHistoryRows = React.useMemo(() => sortCounterHistory(historyRows, historySort), [historyRows, historySort]);
  const selectedHistory = historyRows.find((row) => row.freightCharge.id === selectedHistoryId) ?? null;
  const historyHeader = (label: string, key: HistorySortKey) => {
    const active = historySort.key === key;
    const Icon = active ? (historySort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
    return {
      header: (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Sort by ${label}${active ? `, currently ${historySort.direction === "asc" ? "ascending" : "descending"}` : ""}`}
          aria-pressed={active}
          onClick={() => setHistorySort((previous) => previous.key === key
            ? { ...previous, direction: previous.direction === "asc" ? "desc" : "asc" }
            : { key, direction: key === "booked" ? "desc" : "asc" })}
        >
          {label}<Icon className="size-3.5" aria-hidden />
        </button>
      ),
      ...(active ? { ariaSort: historySort.direction === "asc" ? "ascending" as const : "descending" as const } : {}),
    };
  };
  const historyColumns: Column<CounterHistoryRow>[] = [
    { key: "booked", ...historyHeader("Booked", "booked"), width: "w-[155px]", cell: (row) => new Date(row.freightCharge.createdAt).toLocaleString("en-LK", { dateStyle: "medium", timeStyle: "short" }) },
    { key: "awb", ...historyHeader("Tracking number", "awb"), width: "w-[160px]", className: "whitespace-nowrap", cell: (row) => <MonoCell>{row.freightCharge.awb}</MonoCell> },
    { key: "sender", ...historyHeader("Sender", "sender"), width: "w-[170px]", cell: (row) => row.freightCharge.senderName },
    { key: "receiver", ...historyHeader("Receiver phone", "receiver"), width: "w-[145px]", className: "whitespace-nowrap", cell: (row) => row.freightCharge.recipientPhone },
    { key: "item", ...historyHeader("Parcel", "item"), width: "w-[190px]", cell: (row) => row.parcel.description || "No description" },
    { key: "branch", ...historyHeader("Branch / hub", "branch"), width: "w-[150px]", cell: (row) => row.freightCharge.branchName },
    { key: "payer", ...historyHeader("Payer", "payer"), width: "w-[120px]", cell: (row) => row.freightCharge.payer === "sender" ? "Sender" : "Recipient" },
    { key: "charge", ...historyHeader("Charge", "charge"), width: "w-[115px]", align: "right", className: "whitespace-nowrap font-mono", cell: (row) => money(row.freightCharge.amountCents) },
    { key: "due", ...historyHeader("Paid / due", "due"), width: "w-[130px]", align: "right", className: "whitespace-nowrap", cell: (row) => row.dueCents <= 0 ? <span className="font-medium text-status-success">Paid</span> : `Due ${money(row.dueCents)}` },
    { key: "document", header: "Document", width: "w-[145px]", cell: (row) => <Button size="sm" variant="outline" className="whitespace-nowrap" onClick={() => setSelectedHistoryId(row.freightCharge.id)}><Search aria-hidden />View receipt / notice</Button> },
  ];

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
      discountCents: discountAmountCents ?? 0,
      cashReceivedCents: cashCollectionRequired ? cashReceivedCents : null,
      externalReference: form.payer === "sender" && form.paymentMethod !== "cash" ? form.externalReference.trim() : null,
      consigneeName: form.consigneeName.trim(),
      consigneePhone: form.consigneePhone.trim(),
      destAddress: destinationAddress,
      destLat: null,
      destLng: null,
      destZoneId: null,
    }),
    onSuccess: (result) => {
      submissionInFlight.current = false;
      setBooking(result);
      void queryClient.invalidateQueries();
      const popup = receiptPopupRef.current;
      receiptPopupRef.current = null;
      const printed = printCounterReceiptWindow(
        popup,
        renderFreightReceiptDocument({ booking: result, branch: selectedBranch, receiptContact: receiptContact.data }),
        () => setPrintNotice("Your booking is saved, but the receipt logo or printer failed to load. Use Print original document; do not accept the parcel again."),
      );
      if (!printed) closeCounterReceiptWindow(popup);
      setPrintNotice(printed
        ? "Receipt opened for printing. Choose the 80 mm receipt printer; manual reprint remains available."
        : "Your booking is saved, but the receipt popup or printer was blocked. Use Print original document to reprint without booking again.");
    },
    onError: (error) => {
      submissionInFlight.current = false;
      closeCounterReceiptWindow(receiptPopupRef.current);
      receiptPopupRef.current = null;
      if (/rate card changed/i.test(apiMessage(error, ""))) void priceQuote.refetch();
    },
  });

  const valid = Boolean(
    form.branchId && "grams" in weight && weight.grams > 0 &&
    dimensionsValid && !weightLimitError && priceQuote.data && priceQuote.data.totalCents > 0 && !priceQuote.isFetching && !priceQuote.isError &&
    discountAmountCents !== null && !discountError && discountedChargeCents !== null && discountedChargeCents > 0 && !cashReceivedError &&
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
    setPrintNotice(null);
    setForm(empty(session?.user.branchId ?? form.branchId));
    create.reset();
  };
  const canPrint = activeTab === "booking" && Boolean(booking);

  return (
    <Page
      title="Customer counter booking"
      description="Book walk-in customer parcels without a dummy merchant. Courier payment is separate from COD; the tracking number is printed on the receipt. No booking SMS is sent."
      actions={canPrint ? <Button size="sm" variant="outline" onClick={() => window.print()}><Printer aria-hidden />Print original document</Button> : null}
    >
      {receiptContact.error ? <ErrorNote>{apiMessage(receiptContact.error, "Receipt contact details could not be loaded.")}</ErrorNote> : null}
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
                    <KeyValue label="Tracking number" mono>{booking.parcel.awb}</KeyValue>
                    <KeyValue label="Status">{booking.parcel.status}</KeyValue>
                    <KeyValue label={booking.paidReceipt ? "Payment receipt" : "Charge notice"} mono>{booking.paidReceipt?.code ?? booking.freightCharge.code}</KeyValue>
                    <KeyValue label="Courier payment">{money(booking.freightCharge.amountCents)}</KeyValue>
                    <KeyValue label="Payer">{booking.freightCharge.payer === "sender" ? "Sender — paid at counter" : "Recipient — due at delivery"}</KeyValue>
                    <KeyValue label="COD">Rs. 0.00 — not a COD parcel</KeyValue>
                  </KeyValueGrid>
                  <p className="mt-3 text-sm text-muted-foreground">The tracking number is on the receipt. No booking or tracking SMS is sent; POD messaging is limited to delivery confirmation.</p>
                  {printNotice ? <output className="mt-2 block text-sm text-muted-foreground">{printNotice}</output> : null}
                </div>
              </div>
              <Button className="mt-4" size="sm" variant="outline" onClick={reset}><RotateCcw aria-hidden />Book another parcel</Button>
            </Card>
            <FreightReceipt booking={booking} branch={selectedBranch} receiptContact={receiptContact.data} />
          </>
        ) : (
          <form
            className="grid max-w-6xl gap-5 xl:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || create.isPending || submissionInFlight.current) return;
              submissionInFlight.current = true;
              receiptPopupRef.current = openCounterReceiptWindow((url, target, features) => window.open(url, target, features));
              setPrintNotice(null);
              create.mutate();
            }}
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
                  <Field label="Branch tracking number sticker" hint={awbHint} error={awbInlineError}>
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
                    <Field label="Weight (kg)" hint={`Maximum chargeable weight: ${kilogramsLabel(maxWeightGrams)} kg (actual or volumetric).`} error={"error" in weight ? weight.error : weightLimitError}><Input value={form.weightKg} onChange={set("weightKg")} inputMode="decimal" required /></Field>
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
                  <Field label="Discount (Rs.)" hint="Optional amount deducted from the rate-card courier charge." error={discountError}>
                    <Input value={form.discount} onChange={set("discount")} inputMode="decimal" placeholder="0.00" aria-invalid={Boolean(discountError)} />
                  </Field>
                  {priceQuote.data ? (
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-[12px]">
                      <p className="flex justify-between gap-3"><span>Rate-card charge</span><span className="font-mono">{money(priceQuote.data.totalCents)}</span></p>
                      {discountAmountCents !== null && discountAmountCents > 0 ? <p className="flex justify-between gap-3 text-muted-foreground"><span>Discount</span><span className="font-mono">−{money(discountAmountCents)}</span></p> : null}
                      <p className="mt-1 flex justify-between gap-3 border-t border-border pt-1 font-semibold"><span>{form.payer === "sender" ? "Amount payable now" : "Amount due at delivery"}</span><span className="font-mono">{money(discountedChargeCents)}</span></p>
                    </div>
                  ) : null}
                  {!canQuote && selectedBranch && !selectedBranch.counterRateCardId ? <p className="text-xs text-status-warn">Ask an Admin to assign an approved Counter rate card to this branch in Administration → Branches.</p> : null}
                  {!canQuote && (lengthCm !== null || widthCm !== null || heightCm !== null) && !dimensionsValid ? <p className="text-xs text-status-warn">Dimensions must be positive whole centimetres.</p> : null}
                  <Field label="Who pays courier charges?">
                    <Select value={form.payer} onChange={(event) => setForm((previous) => ({ ...previous, payer: event.target.value as FormState["payer"], cashReceived: "" }))}>
                      <option value="sender">Sender pays at counter now</option>
                      <option value="recipient">Recipient pays the Rider at delivery</option>
                    </Select>
                  </Field>
                  {form.payer === "sender" ? (
                    <>
                      <Field label="Payment method">
                        <Select value={form.paymentMethod} onChange={(event) => setForm((previous) => ({ ...previous, paymentMethod: event.target.value as FormState["paymentMethod"], cashReceived: "" }))}>
                          <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="qr">QR payment</option><option value="card">Card</option>
                        </Select>
                      </Field>
                      {form.paymentMethod !== "cash" ? <Field label="Payment reference"><Input value={form.externalReference} onChange={set("externalReference")} required placeholder="Bank / QR / card reference" /></Field> : null}
                      {cashCollectionRequired ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <Field label="Cash received from customer (Rs.)" hint="Enter the amount handed over; the balance is calculated below." error={cashReceivedError}>
                            <Input value={form.cashReceived} onChange={set("cashReceived")} inputMode="decimal" placeholder="0.00" aria-invalid={Boolean(cashReceivedError)} />
                          </Field>
                          <div className="flex min-h-16 flex-col justify-center rounded-md border border-border bg-muted/30 px-3 py-2" aria-live="polite">
                            <span className="text-[12px] text-muted-foreground">{cashShortCents !== null && cashShortCents > 0 ? "Still to collect" : "Change to return"}</span>
                            <span className="font-mono text-sm font-semibold">{cashShortCents !== null && cashShortCents > 0 ? money(cashShortCents) : changeDueCents !== null ? money(changeDueCents) : "—"}</span>
                          </div>
                        </div>
                      ) : null}
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
          <Card title="Counter booking history" description="Search by tracking number, sender name, or sender/receiver phone number. Click a column title to sort the latest 50 shown; search to find older bookings. Select a row’s document action to view and print it again.">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Search history" className="min-w-0">
                <Input value={historyTerm} onChange={(event) => { setHistoryTerm(event.target.value); setSelectedHistoryId(null); }} placeholder="tracking number, sender, or receiver phone" />
              </Field>
              {canChooseBranch ? (
                <Field label="Branch / hub" hint="Admins can filter Counter bookings by location." className="min-w-0">
                  <Select value={historyBranchId} onChange={(event) => { setHistoryBranchId(event.target.value); setSelectedHistoryId(null); }}>
                    <option value="">All locations</option>
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.type ? ` · ${branch.type}` : ""}</option>)}
                  </Select>
                </Field>
              ) : (
                <div className="min-w-0">
                  <p className="mb-1 text-[13px] font-medium">Branch / hub</p>
                  <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Showing bookings for {session?.user.branchName ?? "your assigned branch / hub"} only.</p>
                </div>
              )}
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Field label="Date filter" className="min-w-0">
                <Select value={historyDatePreset} onChange={(event) => { setHistoryDatePreset(event.target.value as CounterHistoryDatePreset); setSelectedHistoryId(null); }}>
                  <option value="all">All dates</option>
                  <option value="today">Today</option>
                  <option value="yesterday">Yesterday</option>
                  <option value="this_week">This week</option>
                  <option value="this_month">This month</option>
                  <option value="this_year">This year</option>
                  <option value="custom">Custom date range</option>
                </Select>
              </Field>
              {historyDatePreset === "custom" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="From date">
                    <Input type="date" value={historyCustomStart} onChange={(event) => { setHistoryCustomStart(event.target.value); setSelectedHistoryId(null); }} />
                  </Field>
                  <Field label="To date">
                    <Input type="date" value={historyCustomEnd} onChange={(event) => { setHistoryCustomEnd(event.target.value); setSelectedHistoryId(null); }} />
                  </Field>
                </div>
              ) : null}
            </div>
            {historyDatePreset === "custom" && !historyDateFilterReady ? (
              <p className="mt-2 text-xs text-status-warn">{historyCustomRangeInvalid ? "The start date must be on or before the end date." : "Choose both dates to load Counter bookings for a custom range."}</p>
            ) : null}
          </Card>
          {historyDateFilterReady ? (
          <DataTable
            columns={historyColumns}
            rows={sortedHistoryRows}
            rowKey={(row) => row.freightCharge.id}
            loading={historyQuery.isLoading}
            error={historyQuery.isError ? apiMessage(historyQuery.error, "Counter history could not be loaded.") : null}
            emptyTitle="No Counter bookings found"
            emptyDescription="No bookings match the selected search, branch / hub, or date filter."
            dense
            tableClassName="min-w-[1380px]"
          />
          ) : null}
          {historyDateFilterReady && historyQuery.data && historyQuery.data.total > historyRows.length ? (
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
        {selectedHistory ? <FreightReceipt booking={selectedHistory} branch={branches.find((branch) => branch.id === selectedHistory.freightCharge.branchId)} receiptContact={receiptContact.data} duplicate /> : null}
      </Dialog>
    </Page>
  );
}
