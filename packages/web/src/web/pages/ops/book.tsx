import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MapPin, Printer } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { filterBookableMerchants, MerchantPicker } from "./merchant-picker";
import {
  closeCounterReceiptWindow,
  openCounterReceiptWindow,
  printCounterReceiptWindow,
  renderCounterBookingReceipt,
  type CounterBookingReceiptData,
  type ReceiptPrintWindow,
} from "./counter-print";
import { money, toE6, metres } from "@/lib/format";
import { chargeableWeightGrams, DEFAULT_BOOKING_WEIGHT_LIMIT_GRAMS, kgToGrams, kilogramsLabel, rupeesToCents } from "@/lib/csv";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { StatusPill } from "@/components/natex/status-pill";
import { Badge } from "@/components/ui/badge";
import { AddressFields } from "@/components/natex/address-fields";
import { EMPTY_ADDRESS, addressPartsFromLegacy, formatAddress, isCompleteAddress, type AddressParts } from "@/lib/address";

/**
 * Counter booking. Money is entered in rupees and converted to integer cents
 * before it crosses the API — §9 forbids a float anywhere near money, and the
 * API refuses a non-integer.
 */

interface Form {
  merchantId: string;
  initialStatus: "Booked" | "AtOriginHub";
  awb: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  declaredValue: string;
  codAmount: string;
  originAddress: AddressParts;
  consigneeName: string;
  consigneePhone: string;
  destAddress: AddressParts;
  destLat: string;
  destLng: string;
}

interface EditForm {
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  description: string;
  declaredValue: string;
  codAmount: string;
  originAddress: AddressParts;
  consigneeName: string;
  consigneePhone: string;
  destAddress: AddressParts;
}

const EMPTY: Form = {
  merchantId: "",
  initialStatus: "Booked",
  awb: "",
  weightKg: "1",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  declaredValue: "0",
  codAmount: "0",
  originAddress: { ...EMPTY_ADDRESS },
  consigneeName: "",
  consigneePhone: "",
  destAddress: { ...EMPTY_ADDRESS },
  destLat: "",
  destLng: "",
};

const EMPTY_EDIT: EditForm = {
  weightKg: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  description: "",
  declaredValue: "",
  codAmount: "",
  originAddress: { ...EMPTY_ADDRESS },
  consigneeName: "",
  consigneePhone: "",
  destAddress: { ...EMPTY_ADDRESS },
};

type Booking = Awaited<ReturnType<typeof client.parcels.create>>;

function receiptDataForBooking(booking: Booking, branch: CounterBookingReceiptData["branch"], receiptContact?: CounterBookingReceiptData["receiptContact"]): CounterBookingReceiptData {
  return {
    awb: booking.parcel.awb,
    status: booking.parcel.status,
    branch,
    receiptContact,
    originAddress: booking.parcel.originAddress,
    consigneeName: booking.parcel.consigneeName,
    consigneePhone: booking.parcel.consigneePhone,
    destAddress: booking.parcel.destAddress,
    weightGrams: booking.parcel.weightGrams,
    lengthCm: booking.parcel.lengthCm,
    widthCm: booking.parcel.widthCm,
    heightCm: booking.parcel.heightCm,
    declaredValueCents: booking.parcel.declaredValueCents ?? 0,
    codAmountCents: booking.parcel.codAmountCents,
    bookedAt: booking.parcel.createdAt,
  };
}

export default function OpsBook() {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [booked, setBooked] = React.useState<Booking | null>(null);
  const [editAwb, setEditAwb] = React.useState("");
  const [editParcel, setEditParcel] = React.useState<Awaited<ReturnType<typeof client.parcels.get>>["parcel"] | null>(null);
  const [editForm, setEditForm] = React.useState<EditForm>(EMPTY_EDIT);
  const [printNotice, setPrintNotice] = React.useState<string | null>(null);
  const receiptPopupRef = React.useRef<ReceiptPrintWindow | null>(null);
  const submissionInFlight = React.useRef(false);

  const loadEditParcel = useMutation({
    mutationFn: () => client.parcels.get({ awbOrId: editAwb.trim().toUpperCase() }),
    onSuccess: (detail) => {
      const parcel = detail.parcel;
      setEditParcel(parcel);
      setEditForm({
        weightKg: (parcel.weightGrams / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, ""),
        lengthCm: parcel.lengthCm == null ? "" : String(parcel.lengthCm),
        widthCm: parcel.widthCm == null ? "" : String(parcel.widthCm),
        heightCm: parcel.heightCm == null ? "" : String(parcel.heightCm),
        description: parcel.description ?? "",
        declaredValue: ((parcel.declaredValueCents ?? 0) / 100).toFixed(2),
        codAmount: (parcel.codAmountCents / 100).toFixed(2),
        originAddress: addressPartsFromLegacy(parcel.originAddress),
        consigneeName: parcel.consigneeName,
        consigneePhone: parcel.consigneePhone,
        destAddress: addressPartsFromLegacy(parcel.destAddress),
      });
    },
  });

  const saveEdit = useMutation({
    mutationFn: () => {
      if (!editParcel) throw new Error("Load a parcel before saving.");
      return client.parcels.editAtOriginHub({
        awbOrId: editParcel.awb,
        weightGrams: Math.round(Number(editForm.weightKg) * 1000),
        lengthCm: editForm.lengthCm ? Number(editForm.lengthCm) : null,
        widthCm: editForm.widthCm ? Number(editForm.widthCm) : null,
        heightCm: editForm.heightCm ? Number(editForm.heightCm) : null,
        description: editForm.description.trim() || null,
        declaredValueCents: Math.round(Number(editForm.declaredValue) * 100),
        codAmountCents: Math.round(Number(editForm.codAmount) * 100),
        originAddress: formatAddress(editForm.originAddress),
        originLat: editParcel.originLat ?? null,
        originLng: editParcel.originLng ?? null,
        consigneeName: editForm.consigneeName.trim(),
        consigneePhone: editForm.consigneePhone.trim(),
        destAddress: formatAddress(editForm.destAddress),
        destLat: editParcel.destLat ?? null,
        destLng: editParcel.destLng ?? null,
        destZoneId: editParcel.destZoneId ?? null,
      });
    },
    onSuccess: (updated) => {
      setEditParcel(updated);
      void queryClient.invalidateQueries();
    },
  });

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const bookableMerchants = filterBookableMerchants(merchants.data ?? [], "");
  const branch = useQuery({
    ...orpc.identity.myBranch.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const receiptContact = useQuery(orpc.settings.receiptContact.queryOptions());
  const bookingLimits = useQuery({
    ...orpc.settings.bookingLimits.queryOptions(),
    staleTime: 0,
    refetchInterval: 30_000,
  });
  const maxWeightGrams = bookingLimits.data?.maxChargeableWeightGrams ?? DEFAULT_BOOKING_WEIGHT_LIMIT_GRAMS;
  const [checkedSticker, setCheckedSticker] = React.useState({ merchantId: "", awb: "" });
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setCheckedSticker({ merchantId: form.merchantId, awb: form.awb.trim().toUpperCase() });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [form.awb, form.merchantId]);
  const enteredAwb = form.awb.trim().toUpperCase();
  const awbFormatValid = /^NX\d{10}$/.test(enteredAwb);
  const stickerQueryCurrent = checkedSticker.merchantId === form.merchantId && checkedSticker.awb === enteredAwb;
  const awbCheck = useQuery({
    queryKey: ["ops-book-awb-check", checkedSticker.merchantId, checkedSticker.awb],
    queryFn: () => client.awbBatches.checkForMerchantBooking({ merchantId: checkedSticker.merchantId, awb: checkedSticker.awb }),
    enabled: Boolean(stickerQueryCurrent && checkedSticker.merchantId && /^NX\d{10}$/.test(checkedSticker.awb)),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const awbFieldError = !enteredAwb
    ? null
    : !form.merchantId
      ? "Select a Merchant before validating this sticker."
      : enteredAwb.length >= 12 && !awbFormatValid
        ? "Enter a valid 12-character NX tracking number."
        : stickerQueryCurrent && awbCheck.data && !awbCheck.data.valid
          ? awbCheck.data.reason
          : stickerQueryCurrent && awbCheck.isError
            ? "Could not verify this sticker. Check your connection and try again."
            : null;
  const awbFieldHint = !enteredAwb
    ? "Optional. If entered, this sticker must be unused and allocated to the selected Merchant."
    : !form.merchantId
      ? "Select a Merchant to check its sticker allocation."
      : !awbFormatValid
        ? "Enter the full 12-character NX tracking number to validate it."
        : !stickerQueryCurrent || awbCheck.isFetching
          ? "Checking the selected Merchant's sticker allocation…"
          : awbCheck.data?.valid
            ? "Allocated to this Merchant and available."
            : undefined;
  const awbOutlineClass = !enteredAwb || (!awbFormatValid && enteredAwb.length < 12) || (awbFormatValid && (!stickerQueryCurrent || awbCheck.isFetching))
    ? "border-amber-400 focus-visible:border-amber-500"
    : awbCheck.data?.valid && !awbCheck.isError
      ? "border-emerald-500 focus-visible:border-emerald-600"
      : "border-rose-500 focus-visible:border-rose-600";

  const set = <K extends keyof Form>(key: K) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

  const hasCoords = form.destLat.trim() !== "" && form.destLng.trim() !== "";

  // Serviceability is checked live once coordinates are entered, so the counter
  // knows before booking whether the destination is inside a zone (§5).
  const serviceability = useQuery({
    ...orpc.routing.checkServiceability.queryOptions({
      input: { lat: Number(form.destLat), lng: Number(form.destLng) },
    }),
    enabled: hasCoords && !Number.isNaN(Number(form.destLat)) && !Number.isNaN(Number(form.destLng)),
  });

  // Money and weight by string arithmetic (lib/csv) — never Math.round(x * 100).
  const declared = rupeesToCents(form.declaredValue);
  const cod = rupeesToCents(form.codAmount);
  const weight = kgToGrams(form.weightKg, maxWeightGrams);
  const dimensionValue = (value: string) => value.trim() && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const chargeableWeight = "grams" in weight
    ? chargeableWeightGrams(weight.grams, dimensionValue(form.lengthCm), dimensionValue(form.widthCm), dimensionValue(form.heightCm))
    : null;
  const weightLimitError = chargeableWeight !== null && chargeableWeight > maxWeightGrams
    ? `Chargeable weight including parcel size cannot exceed ${kilogramsLabel(maxWeightGrams)} kg.`
    : null;
  const centsOf = (r: ReturnType<typeof rupeesToCents>) => ("cents" in r ? r.cents : 0);

  const create = useMutation({
    mutationFn: () =>
      client.parcels.create({
        merchantId: form.merchantId,
        initialStatus: form.initialStatus,
        awb: form.awb.trim() || null,
        weightGrams: "grams" in weight ? weight.grams : 0,
        lengthCm: form.lengthCm ? Number(form.lengthCm) : null,
        widthCm: form.widthCm ? Number(form.widthCm) : null,
        heightCm: form.heightCm ? Number(form.heightCm) : null,
        declaredValueCents: centsOf(declared),
        codAmountCents: centsOf(cod),
        originAddress: formatAddress(form.originAddress),
        consigneeName: form.consigneeName.trim(),
        consigneePhone: form.consigneePhone.trim(),
        destAddress: formatAddress(form.destAddress),
        destLat: hasCoords ? toE6(Number(form.destLat)) : null,
        destLng: hasCoords ? toE6(Number(form.destLng)) : null,
        destZoneId: serviceability.data?.zone?.id ?? null,
      }),
    onSuccess: (result) => {
      submissionInFlight.current = false;
      setBooked(result);
      setForm({ ...EMPTY, merchantId: form.merchantId });
      void queryClient.invalidateQueries();
      const popup = receiptPopupRef.current;
      receiptPopupRef.current = null;
      if (popup) {
        const printed = printCounterReceiptWindow(
          popup,
          renderCounterBookingReceipt(receiptDataForBooking(result, branch.data ?? {
            name: result.parcel.branchId,
            address: result.parcel.originAddress,
          }, receiptContact.data)),
          () => setPrintNotice("The receipt logo or printer could not be loaded. Your booking is saved; use Print / open receipt to retry."),
        );
        if (!printed) {
          closeCounterReceiptWindow(popup);
          setPrintNotice("The receipt window could not be printed. Use Print / open receipt below to try again.");
        } else {
          setPrintNotice("Receipt opened for printing. If your browser blocked printing, use Print / open receipt below.");
        }
      } else {
        setPrintNotice("The receipt popup was blocked. Use Print / open receipt below to print this booking.");
      }
    },
    onError: () => {
      submissionInFlight.current = false;
      closeCounterReceiptWindow(receiptPopupRef.current);
      receiptPopupRef.current = null;
    },
  });

  const valid =
    form.merchantId !== "" &&
    bookableMerchants.some((merchant) => merchant.id === form.merchantId) &&
    (!enteredAwb || (awbFormatValid && stickerQueryCurrent && awbCheck.data?.valid && !awbCheck.isFetching && !awbCheck.isError)) &&
    "grams" in weight &&
    weight.grams > 0 &&
    !weightLimitError &&
    "cents" in declared &&
    "cents" in cod &&
    isCompleteAddress(form.originAddress) &&
    form.consigneeName.trim().length >= 2 &&
    form.consigneePhone.trim().length >= 9 &&
    isCompleteAddress(form.destAddress);

  const printBooking = (booking: Booking) => {
    const popup = openCounterReceiptWindow((url, target, features) =>
      window.open(url, target, features) as ReceiptPrintWindow | null,
    );
    const printed = printCounterReceiptWindow(
      popup,
      renderCounterBookingReceipt(receiptDataForBooking(booking, branch.data ?? {
        name: booking.parcel.branchId,
        address: booking.parcel.originAddress,
      }, receiptContact.data)),
      () => setPrintNotice("The receipt logo or printer could not be loaded. Retry printing; do not book this parcel again."),
    );
    if (!printed) {
      closeCounterReceiptWindow(popup);
      setPrintNotice("Your browser blocked the receipt popup or the printer was unavailable. Allow popups, then try again.");
      return;
    }
    setPrintNotice("Receipt opened for printing.");
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || create.isPending || submissionInFlight.current) return;
    submissionInFlight.current = true;
    receiptPopupRef.current = openCounterReceiptWindow((url, target, features) =>
      window.open(url, target, features) as ReceiptPrintWindow | null,
    );
    if (!receiptPopupRef.current) {
      setPrintNotice("Automatic receipt popup was blocked. The booking will still be saved; use the manual print action after success.");
    } else {
      setPrintNotice(null);
    }
    create.mutate();
  };

  const editValid = Boolean(
    editParcel &&
    editParcel.status === "AtOriginHub" &&
    Number.isFinite(Number(editForm.weightKg)) &&
    Number(editForm.weightKg) > 0 &&
    Number.isFinite(Number(editForm.declaredValue)) &&
    Number(editForm.declaredValue) >= 0 &&
    Number.isFinite(Number(editForm.codAmount)) &&
    Number(editForm.codAmount) >= 0 &&
    isCompleteAddress(editForm.originAddress) &&
    editForm.consigneeName.trim().length >= 2 &&
    editForm.consigneePhone.trim().length >= 9 &&
    isCompleteAddress(editForm.destAddress),
  );

  return (
    <Page
      title="Book a parcel"
      description="Creates the parcel at the selected starting custody state and writes the first custody event. A supplied tracking number must be an unused sticker allocated to the selected merchant."
    >
      {receiptContact.error ? <ErrorNote>{apiMessage(receiptContact.error, "Receipt contact details could not be loaded.")}</ErrorNote> : null}
      <Card
        title="Edit parcel"
        description="Load an existing parcel by tracking number and correct it here before it leaves At Origin Hub."
        className="mb-5 max-w-5xl border-sky-400/70 bg-sky-50/30 dark:bg-sky-950/10"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Tracking number" hint="Only parcels currently at At Origin Hub can be edited." className="min-w-[260px] flex-1">
            <Input
              value={editAwb}
              onChange={(event) => setEditAwb(event.target.value.toUpperCase())}
              placeholder="NX1234567890"
              className="font-mono"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (editAwb.trim()) loadEditParcel.mutate();
                }
              }}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            pending={loadEditParcel.isPending}
            disabled={!editAwb.trim()}
            onClick={() => loadEditParcel.mutate()}
          >
            Load parcel
          </Button>
        </div>
        {loadEditParcel.error ? <ErrorNote className="mt-3">{apiMessage(loadEditParcel.error, "This parcel could not be loaded.")}</ErrorNote> : null}
        {editParcel ? (
          <div className="mt-4 space-y-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{editParcel.awb}</span>
              <StatusPill status={editParcel.status} />
              {editParcel.status !== "AtOriginHub" ? (
                <span className="text-[12px] text-muted-foreground">Editing is available only at At Origin Hub.</span>
              ) : null}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="grid grid-cols-4 gap-3">
                <Field label="Weight (kg)" className="col-span-4 sm:col-span-1">
                  <Input value={editForm.weightKg} onChange={(event) => setEditForm((prev) => ({ ...prev, weightKg: event.target.value }))} inputMode="decimal" />
                </Field>
                <Field label="L (cm)"><Input value={editForm.lengthCm} onChange={(event) => setEditForm((prev) => ({ ...prev, lengthCm: event.target.value }))} inputMode="numeric" /></Field>
                <Field label="W (cm)"><Input value={editForm.widthCm} onChange={(event) => setEditForm((prev) => ({ ...prev, widthCm: event.target.value }))} inputMode="numeric" /></Field>
                <Field label="H (cm)"><Input value={editForm.heightCm} onChange={(event) => setEditForm((prev) => ({ ...prev, heightCm: event.target.value }))} inputMode="numeric" /></Field>
                <Field label="Declared value (Rs.)" className="col-span-2"><Input value={editForm.declaredValue} onChange={(event) => setEditForm((prev) => ({ ...prev, declaredValue: event.target.value }))} inputMode="decimal" /></Field>
                <Field label="COD (Rs.)" className="col-span-2"><Input value={editForm.codAmount} onChange={(event) => setEditForm((prev) => ({ ...prev, codAmount: event.target.value }))} inputMode="decimal" /></Field>
                <Field label="Description" className="col-span-4"><Input value={editForm.description} onChange={(event) => setEditForm((prev) => ({ ...prev, description: event.target.value }))} /></Field>
                <Field label="Pickup address" className="col-span-4"><AddressFields title="" value={editForm.originAddress} onChange={(originAddress) => setEditForm((prev) => ({ ...prev, originAddress }))} /></Field>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Consignee name"><Input value={editForm.consigneeName} onChange={(event) => setEditForm((prev) => ({ ...prev, consigneeName: event.target.value }))} /></Field>
                  <Field label="Consignee phone"><Input value={editForm.consigneePhone} onChange={(event) => setEditForm((prev) => ({ ...prev, consigneePhone: event.target.value }))} inputMode="tel" /></Field>
                </div>
                <AddressFields title="Delivery address" value={editForm.destAddress} onChange={(destAddress) => setEditForm((prev) => ({ ...prev, destAddress }))} />
              </div>
            </div>
            {saveEdit.error ? <ErrorNote>{apiMessage(saveEdit.error, "The parcel could not be updated.")}</ErrorNote> : null}
            {saveEdit.data ? <p className="text-[12px] text-status-good">Parcel updated successfully.</p> : null}
            <Button type="button" pending={saveEdit.isPending} disabled={!editValid} onClick={() => saveEdit.mutate()}>
              Save parcel changes
            </Button>
          </div>
        ) : null}
      </Card>
      {booked ? (
        <Card className="max-w-3xl border-status-good/40 bg-status-good/8">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-good" aria-hidden />
            <div>
              <p className="text-[14px] font-semibold">Parcel booked</p>
              <p className="mt-1 flex items-center gap-2 text-[13px]">
                <span className="font-mono text-[16px] font-medium">{booked.parcel.awb}</span>
                <StatusPill status={booked.parcel.status} />
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                It is now awaiting pickup. Add it to a pickup manifest to hand it to a
                rider.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => printBooking(booked)}>
                  <Printer aria-hidden /> Print / open receipt
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBooked(null);
                    setPrintNotice(null);
                  }}
                >
                  Book another
                </Button>
              </div>
              {printNotice ? <output className="mt-3 block text-[12px] text-muted-foreground">{printNotice}</output> : null}
            </div>
          </div>
        </Card>
      ) : null}

      <form
        className="grid max-w-5xl gap-5 lg:grid-cols-2"
        onSubmit={submit}
      >
        <Card title="Merchant &amp; Sender" className="border-amber-400/70 bg-amber-50/30 dark:bg-amber-950/10">
          <div className="space-y-4">
            <Field label="Merchant" hint="Only merchants in your assigned district are listed.">
              <MerchantPicker
                merchants={bookableMerchants}
                value={form.merchantId}
                onChange={(merchantId) => {
                  const merchant = bookableMerchants.find((item) => item.id === merchantId);
                  setForm((prev) => ({
                    ...prev,
                    merchantId,
                    originAddress: merchant
                      ? addressPartsFromLegacy(merchant.address)
                      : { ...EMPTY_ADDRESS },
                  }));
                }}
                loading={merchants.isLoading}
                error={merchants.isError ? apiMessage(merchants.error, "Merchants could not be loaded.") : null}
              />
            </Field>
            <fieldset className="rounded-md border border-border p-3">
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Starting custody</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
                  <input type="checkbox" checked={form.initialStatus === "Booked"} onChange={() => setForm((prev) => ({ ...prev, initialStatus: "Booked" }))} />
                  <span><strong>Book a parcel</strong><span className="block text-xs text-muted-foreground">Normal flow; awaiting pickup.</span></span>
                </label>
                <label className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
                  <input type="checkbox" checked={form.initialStatus === "AtOriginHub"} onChange={() => setForm((prev) => ({ ...prev, initialStatus: "AtOriginHub" }))} />
                  <span><strong>Make it At Origin Hub</strong><span className="block text-xs text-muted-foreground">Use when it is already physically at this hub.</span></span>
                </label>
              </div>
            </fieldset>
            <Field label="Preprinted tracking number sticker" hint={awbFieldHint} error={awbFieldError}>
              <Input value={form.awb} onChange={(event) => setForm((prev) => ({ ...prev, awb: event.target.value.toUpperCase() }))} placeholder="NX1234567890" autoCapitalize="characters" className={`font-mono ${awbOutlineClass}`} aria-invalid={Boolean(awbFieldError)} />
            </Field>
            <div className="grid grid-cols-4 gap-3">
              <Field
                label="Weight (kg)"
                hint={`Maximum chargeable weight: ${kilogramsLabel(maxWeightGrams)} kg (actual or volumetric).`}
                error={form.weightKg && "error" in weight ? weight.error : weightLimitError}
              >
                <Input
                  value={form.weightKg}
                  onChange={set("weightKg")}
                  inputMode="decimal"
                  className="font-mono"
                  required
                />
              </Field>
              <Field label="L (cm)">
                <Input value={form.lengthCm} onChange={set("lengthCm")} inputMode="numeric" className="font-mono" />
              </Field>
              <Field label="W (cm)">
                <Input value={form.widthCm} onChange={set("widthCm")} inputMode="numeric" className="font-mono" />
              </Field>
              <Field label="H (cm)">
                <Input value={form.heightCm} onChange={set("heightCm")} inputMode="numeric" className="font-mono" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Declared value (Rs.)"
                error={"error" in declared ? declared.error : null}
              >
                <Input
                  value={form.declaredValue}
                  onChange={set("declaredValue")}
                  inputMode="decimal"
                  className="font-mono"
                />
              </Field>
              <Field
                label="COD to collect (Rs.)"
                hint={"error" in cod ? undefined : cod.cents === 0 ? "Prepaid parcel" : money(cod.cents)}
                error={"error" in cod ? cod.error : null}
              >
                <Input
                  value={form.codAmount}
                  onChange={set("codAmount")}
                  inputMode="decimal"
                  className="font-mono"
                />
              </Field>
            </div>
            <AddressFields title="Pickup address" value={form.originAddress} onChange={(originAddress) => setForm((prev) => ({ ...prev, originAddress }))} />
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Destination &amp; Recipient" className="border-emerald-500/70 bg-emerald-50/25 dark:bg-emerald-950/10">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Consignee name">
                  <Input value={form.consigneeName} onChange={set("consigneeName")} required />
                </Field>
                <Field label="Consignee phone">
                  <Input
                    value={form.consigneePhone}
                    onChange={set("consigneePhone")}
                    inputMode="tel"
                    placeholder="+9477XXXXXXX"
                    className="font-mono"
                    required
                  />
                </Field>
              </div>
              <AddressFields title="Delivery address" value={form.destAddress} onChange={(destAddress) => setForm((prev) => ({ ...prev, destAddress }))} />
              <div className="grid grid-cols-2 gap-3">
                <Field label="Latitude" hint="Optional — enables the zone check">
                  <Input value={form.destLat} onChange={set("destLat")} inputMode="decimal" placeholder="6.9271" className="font-mono" />
                </Field>
                <Field label="Longitude">
                  <Input value={form.destLng} onChange={set("destLng")} inputMode="decimal" placeholder="79.8612" className="font-mono" />
                </Field>
              </div>
            </div>
          </Card>

          {hasCoords && serviceability.data ? (
            <Card
              title="Serviceability"
              actions={
                <Badge variant={serviceability.data.serviceable ? "brand" : "outline"}>
                  {serviceability.data.serviceable ? "Serviceable" : "Not serviceable"}
                </Badge>
              }
            >
              <p className="text-[13px]">{serviceability.data.reason}</p>
              <KeyValueGrid className="mt-4">
                <KeyValue label="Zone">{serviceability.data.zone?.name ?? "None matched"}</KeyValue>
                <KeyValue label="Containment test" mono>
                  {serviceability.data.method}
                </KeyValue>
                <KeyValue label="Nearest branch">
                  {serviceability.data.nearestBranch?.name ?? "—"}
                </KeyValue>
                <KeyValue label="Distance" mono>
                  {metres(serviceability.data.nearestBranch?.distanceMetres)}
                </KeyValue>
              </KeyValueGrid>
              {!serviceability.data.serviceable ? (
                <p className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
                  <MapPin className="mt-[1px] size-3.5 shrink-0" aria-hidden />
                  Booking is still allowed — M1 records serviceability, it does not block on
                  it. The parcel is left without a destination zone.
                </p>
              ) : null}
            </Card>
          ) : null}

          {create.error ? (
            <ErrorNote>{apiMessage(create.error, "This parcel could not be booked.")}</ErrorNote>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" size="lg" pending={create.isPending} disabled={!valid}>
              Book parcel
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setForm(EMPTY);
                create.reset();
              }}
              disabled={create.isPending}
            >
              Clear
            </Button>
          </div>
        </div>
      </form>
    </Page>
  );
}
