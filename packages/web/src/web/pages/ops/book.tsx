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
import { EMPTY_ADDRESS, formatAddress, isCompleteAddress, type AddressParts } from "@/lib/address";

/**
 * Counter booking. Money is entered in rupees and converted to integer cents
 * before it crosses the API — §9 forbids a float anywhere near money, and the
 * API refuses a non-integer.
 */

interface Form {
  merchantId: string;
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

const EMPTY: Form = {
  merchantId: "",
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
  const [printNotice, setPrintNotice] = React.useState<string | null>(null);
  const receiptPopupRef = React.useRef<ReceiptPrintWindow | null>(null);
  const submissionInFlight = React.useRef(false);

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

  return (
    <Page
      title="Book a parcel"
      description="Creates the parcel at Booked and writes the first custody event. A supplied tracking number must be an unused sticker allocated to the selected merchant."
    >
      {receiptContact.error ? <ErrorNote>{apiMessage(receiptContact.error, "Receipt contact details could not be loaded.")}</ErrorNote> : null}
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
        <Card title="Merchant &amp; consignment">
          <div className="space-y-4">
            <Field label="Merchant" hint="Only merchants in your branch scope are listed.">
              <MerchantPicker
                merchants={bookableMerchants}
                value={form.merchantId}
                onChange={(merchantId) => setForm((prev) => ({ ...prev, merchantId }))}
                loading={merchants.isLoading}
                error={merchants.isError ? apiMessage(merchants.error, "Merchants could not be loaded.") : null}
              />
            </Field>
            <Field label="Preprinted tracking number sticker" hint="Optional for staff. If entered, it must belong to this merchant and be unused.">
              <Input value={form.awb} onChange={set("awb")} placeholder="NX1234567890" autoCapitalize="characters" className="font-mono" />
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
          <Card title="Consignee &amp; destination">
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
