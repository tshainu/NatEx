import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MapPin } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { money, toE6, metres } from "@/lib/format";
import { kgToGrams, rupeesToCents } from "@/lib/csv";
import { Page, Card, ErrorNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { StatusPill } from "@/components/natex/status-pill";
import { Badge } from "@/components/ui/badge";

/**
 * Counter booking. Money is entered in rupees and converted to integer cents
 * before it crosses the API — §9 forbids a float anywhere near money, and the
 * API refuses a non-integer.
 */

interface Form {
  merchantId: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  declaredValue: string;
  codAmount: string;
  originAddress: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  destLat: string;
  destLng: string;
}

const EMPTY: Form = {
  merchantId: "",
  weightKg: "1",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  declaredValue: "0",
  codAmount: "0",
  originAddress: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: "",
  destLat: "",
  destLng: "",
};

export default function OpsBook() {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [booked, setBooked] = React.useState<{ awb: string; status: string } | null>(null);

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

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
  const weight = kgToGrams(form.weightKg);
  const centsOf = (r: ReturnType<typeof rupeesToCents>) => ("cents" in r ? r.cents : 0);

  const create = useMutation({
    mutationFn: () =>
      client.parcels.create({
        merchantId: form.merchantId,
        weightGrams: "grams" in weight ? weight.grams : 0,
        lengthCm: form.lengthCm ? Number(form.lengthCm) : null,
        widthCm: form.widthCm ? Number(form.widthCm) : null,
        heightCm: form.heightCm ? Number(form.heightCm) : null,
        declaredValueCents: centsOf(declared),
        codAmountCents: centsOf(cod),
        originAddress: form.originAddress.trim(),
        consigneeName: form.consigneeName.trim(),
        consigneePhone: form.consigneePhone.trim(),
        destAddress: form.destAddress.trim(),
        destLat: hasCoords ? toE6(Number(form.destLat)) : null,
        destLng: hasCoords ? toE6(Number(form.destLng)) : null,
        destZoneId: serviceability.data?.zone?.id ?? null,
      }),
    onSuccess: (result) => {
      setBooked({ awb: result.parcel.awb, status: result.parcel.status });
      setForm({ ...EMPTY, merchantId: form.merchantId });
      void queryClient.invalidateQueries();
    },
  });

  const valid =
    form.merchantId !== "" &&
    "grams" in weight &&
    weight.grams > 0 &&
    "cents" in declared &&
    "cents" in cod &&
    form.originAddress.trim().length >= 4 &&
    form.consigneeName.trim().length >= 2 &&
    form.consigneePhone.trim().length >= 9 &&
    form.destAddress.trim().length >= 4;

  return (
    <Page
      title="Book a parcel"
      description="Creates the parcel at Booked and writes the first custody event. The AWB is minted server-side and is the parcel's public identity from here on."
    >
      {booked ? (
        <Card className="max-w-3xl border-status-good/40 bg-status-good/8">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-good" aria-hidden />
            <div>
              <p className="text-[14px] font-semibold">Parcel booked</p>
              <p className="mt-1 flex items-center gap-2 text-[13px]">
                <span className="font-mono text-[16px] font-medium">{booked.awb}</span>
                <StatusPill status={booked.status} />
              </p>
              <p className="mt-2 text-[13px] text-muted-foreground">
                It is now awaiting pickup. Add it to a pickup manifest to hand it to a
                rider.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setBooked(null)}
              >
                Book another
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <form
        className="grid max-w-5xl gap-5 lg:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) create.mutate();
        }}
      >
        <Card title="Merchant &amp; consignment">
          <div className="space-y-4">
            <Field label="Merchant" hint="Only merchants in your branch scope are listed.">
              <Select value={form.merchantId} onChange={set("merchantId")} required>
                <option value="">Select a merchant…</option>
                {(merchants.data ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.codEnabled ? "" : " (COD disabled)"}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-4 gap-3">
              <Field label="Weight (kg)" error={form.weightKg && "error" in weight ? weight.error : null}>
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
            <Field label="Pickup address">
              <Textarea value={form.originAddress} onChange={set("originAddress")} required />
            </Field>
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
              <Field label="Delivery address">
                <Textarea value={form.destAddress} onChange={set("destAddress")} required />
              </Field>
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
