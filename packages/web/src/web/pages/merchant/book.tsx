import * as React from "react";
import { Link } from "wouter";
import { CheckCircle2 } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { apiMessage } from "@/lib/api";
import { kgToGrams, rupeesToCents } from "@/lib/csv";
import { FIELD_TO_HEADER } from "@/lib/bulk-csv";
import { money } from "@/lib/format";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { useInvalidateParcels, useMerchantProfile, bulkChunk } from "@/queries/merchant";
import { BulkUpload } from "./book-csv";

/**
 * /merchant/book (§10 M3: merchant booking and bulk upload).
 *
 * Both paths go through `parcels.bulkCreate` — a single booking is a one-row
 * batch — so the merchant sees exactly one set of validation rules, the
 * server's `bulkRowSchema`, whether they type a parcel or upload 2 000. The
 * pickup address is the merchant's address on file; a merchant cannot book a
 * parcel from somewhere else.
 */

type Mode = "single" | "csv";
const MODES = ["single", "csv"] as const;

export default function MerchantBook() {
  const [mode, setMode] = useTabParam<Mode>("mode", MODES, "single");
  const profile = useMerchantProfile();
  const merchant = profile.data;
  const suspended = merchant && merchant.status !== "active";

  return (
    <Page
      title="Book parcels"
      description={
        merchant
          ? `Parcels are collected from your address on file: ${merchant.address}.`
          : "Book one parcel, or upload a CSV for many."
      }
    >
      {suspended ? (
        <ErrorNote>
          This account is {merchant!.status}. NatEx will refuse new bookings until operations
          reactivates it.
        </ErrorNote>
      ) : null}
      <TabStrip
        label="Booking method"
        value={mode}
        onChange={setMode}
        tabs={[
          { id: "single", label: "Single parcel" },
          { id: "csv", label: "Bulk CSV upload" },
        ]}
      />
      <div id={`panel-${mode}`} role="tabpanel" aria-labelledby={`tab-${mode}`}>
        {mode === "single" ? (
          <SingleBooking codEnabled={merchant?.codEnabled ?? true} />
        ) : (
          <BulkUpload codEnabled={merchant?.codEnabled ?? true} />
        )}
      </div>
    </Page>
  );
}

interface Form {
  orderRef: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  cod: string;
  declared: string;
}
const EMPTY: Form = {
  orderRef: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: "",
  weightKg: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  cod: "",
  declared: "",
};

const HEADER_TO_FORM: Record<string, keyof Form> = {
  order_ref: "orderRef",
  consignee_name: "consigneeName",
  consignee_phone: "consigneePhone",
  delivery_address: "destAddress",
  weight_kg: "weightKg",
  length_cm: "lengthCm",
  width_cm: "widthCm",
  height_cm: "heightCm",
  cod_rs: "cod",
  declared_value_rs: "declared",
};

function SingleBooking({ codEnabled }: { codEnabled: boolean }) {
  const merchantId = useAuth().session!.user.merchantId;
  const invalidate = useInvalidateParcels();
  const [form, setForm] = React.useState<Form>(EMPTY);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<keyof Form, string>>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [booked, setBooked] = React.useState<{ awb: string; cod: number } | null>(null);
  // One key per intent: a retry after a network failure replays, it does not
  // book a second parcel. Any edit to the form is a new intent.
  const keyRef = React.useRef<string | null>(null);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    keyRef.current = null;
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setFieldErrors((fe) => ({ ...fe, [k]: undefined }));
  };

  const weight = kgToGrams(form.weightKg);
  const cod = rupeesToCents(form.cod);
  const declared = rupeesToCents(form.declared);

  const submit = async () => {
    setError(null);
    const local: Partial<Record<keyof Form, string>> = {};
    if ("error" in weight) local.weightKg = weight.error;
    if ("error" in cod) local.cod = cod.error;
    if ("error" in declared) local.declared = declared.error;
    for (const k of ["lengthCm", "widthCm", "heightCm"] as const) {
      if (form[k].trim() && !/^\d+$/.test(form[k].trim())) local[k] = "Whole centimetres";
    }
    if (Object.keys(local).length) {
      setFieldErrors(local);
      return;
    }
    if (!merchantId) {
      setError("This login is not linked to a merchant account.");
      return;
    }
    keyRef.current ??= crypto.randomUUID();
    setPending(true);
    try {
      const report = await bulkChunk(
        {
          merchantId,
          dryRun: false,
          rows: [
            {
              line: 1,
              orderRef: form.orderRef.trim() || null,
              consigneeName: form.consigneeName,
              consigneePhone: form.consigneePhone,
              destAddress: form.destAddress,
              weightGrams: (weight as { grams: number }).grams,
              lengthCm: form.lengthCm.trim() ? Number(form.lengthCm) : null,
              widthCm: form.widthCm.trim() ? Number(form.widthCm) : null,
              heightCm: form.heightCm.trim() ? Number(form.heightCm) : null,
              codAmountCents: (cod as { cents: number }).cents,
              declaredValueCents: (declared as { cents: number }).cents,
            },
          ],
        },
        keyRef.current,
      );
      const ok = report.accepted[0];
      if (ok?.awb) {
        setBooked({ awb: ok.awb, cod: ok.codAmountCents });
        setForm(EMPTY);
        keyRef.current = null;
        void invalidate();
      } else {
        const fe: Partial<Record<keyof Form, string>> = {};
        const general: string[] = [];
        for (const e of report.rejected[0]?.errors ?? []) {
          const k = HEADER_TO_FORM[FIELD_TO_HEADER[e.field] ?? ""];
          if (k) fe[k] = e.message;
          else general.push(e.message);
        }
        setFieldErrors(fe);
        setError(general.length ? general.join(" · ") : "Fix the highlighted fields.");
        keyRef.current = null;
      }
    } catch (err) {
      setError(apiMessage(err, "The parcel could not be booked. Try again — a retry will not book it twice."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-5 max-w-4xl space-y-5">
      {booked ? (
        <Card className="border-status-good/40 bg-status-good/8">
          <div className="flex items-start gap-3" aria-live="polite" aria-atomic="true">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-status-good" aria-hidden />
            <div>
              <p className="text-[14px] font-semibold">Parcel booked</p>
              <p className="mt-1 font-mono text-[16px] font-medium" data-testid="booked-awb">
                {booked.awb}
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {booked.cod > 0 ? `COD to collect: ${money(booked.cod)}. ` : "Prepaid. "}
                Add it to a pickup request so a rider collects it.
              </p>
              <div className="mt-3 flex gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href="/merchant/pickups">Request pickup</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setBooked(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <form
        className="grid gap-5 lg:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Card title="Consignee">
          <div className="space-y-4">
            <Field label="Consignee name" error={fieldErrors.consigneeName}>
              <Input value={form.consigneeName} onChange={set("consigneeName")} required autoComplete="off" />
            </Field>
            <Field label="Consignee phone" hint="Sri Lankan mobile, e.g. 0771234567" error={fieldErrors.consigneePhone}>
              <Input
                value={form.consigneePhone}
                onChange={set("consigneePhone")}
                inputMode="tel"
                className="font-mono"
                required
              />
            </Field>
            <Field label="Delivery address" error={fieldErrors.destAddress}>
              <Textarea value={form.destAddress} onChange={set("destAddress")} required />
            </Field>
            <Field label="Your order reference" hint="Optional — shown on reports" error={fieldErrors.orderRef}>
              <Input value={form.orderRef} onChange={set("orderRef")} className="font-mono" />
            </Field>
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="Parcel">
            <div className="space-y-4">
              <div className="grid grid-cols-4 gap-3">
                <Field label="Weight (kg)" error={fieldErrors.weightKg}>
                  <Input value={form.weightKg} onChange={set("weightKg")} inputMode="decimal" className="font-mono" required />
                </Field>
                <Field label="L (cm)" error={fieldErrors.lengthCm}>
                  <Input value={form.lengthCm} onChange={set("lengthCm")} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="W (cm)" error={fieldErrors.widthCm}>
                  <Input value={form.widthCm} onChange={set("widthCm")} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="H (cm)" error={fieldErrors.heightCm}>
                  <Input value={form.heightCm} onChange={set("heightCm")} inputMode="numeric" className="font-mono" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="COD to collect (Rs.)"
                  hint={
                    !codEnabled
                      ? "Your account is prepaid only"
                      : "cents" in cod && cod.cents > 0
                        ? money(cod.cents)
                        : "Leave blank for prepaid"
                  }
                  error={fieldErrors.cod}
                >
                  <Input
                    value={form.cod}
                    onChange={set("cod")}
                    inputMode="decimal"
                    className="font-mono"
                    disabled={!codEnabled}
                  />
                </Field>
                <Field label="Declared value (Rs.)" error={fieldErrors.declared}>
                  <Input value={form.declared} onChange={set("declared")} inputMode="decimal" className="font-mono" />
                </Field>
              </div>
            </div>
          </Card>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex items-center gap-3">
            <Button type="submit" size="lg" pending={pending}>
              Book parcel
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setForm(EMPTY);
                setFieldErrors({});
                setError(null);
                keyRef.current = null;
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
