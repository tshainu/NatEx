import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { centsToRupees, kgToGrams, rupeesToCents } from "@/lib/csv";
import { dateTime, grams, money } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, ErrorNote, SuccessNote } from "@/components/natex/page";
import { useRateCardVersion, type RateCardVersionDoc } from "@/queries/admin";

/**
 * One tariff version: read-only when live or superseded, an editor when it is
 * a draft (admin). Money is typed in rupees and converted to integer cents by
 * string arithmetic (lib/csv) — never through a float. A percentage surcharge
 * is stored in basis points, typed as a percent with at most two decimals
 * (the same fixed-point parse: "2.5" → 250 bp).
 */

interface BandDraft {
  band: string;
  label: string;
  extraPerKg: string;
}
interface SlabDraft {
  band: string;
  maxGrams: string;
  price: string;
}
interface SurchargeDraft {
  code: string;
  label: string;
  kind: "flat" | "percent";
  amount: string;
  mode: "always" | "on_request";
}
interface DocDraft {
  volumetricDivisor: string;
  roundingGrams: string;
  note: string;
  bands: BandDraft[];
  slabs: SlabDraft[];
  surcharges: SurchargeDraft[];
}

function toDraft(doc: RateCardVersionDoc): DocDraft {
  return {
    volumetricDivisor: String(doc.version.volumetricDivisor),
    roundingGrams: String(doc.version.roundingGrams),
    note: doc.version.note ?? "",
    bands: doc.bands.map((b) => ({ band: b.band, label: b.label, extraPerKg: centsToRupees(b.extraPerKgCents) })),
    slabs: doc.slabs.map((s) => ({ band: s.band, maxGrams: String(s.maxGrams), price: centsToRupees(s.priceCents) })),
    surcharges: doc.surcharges.map((s) => ({
      code: s.code,
      label: s.label,
      kind: s.kind,
      amount: centsToRupees(s.amount),
      mode: s.mode,
    })),
  };
}

type SavePayload = {
  volumetricDivisor: number;
  roundingGrams: number;
  note: string | null;
  bands: { band: string; label: string; extraPerKgCents: number }[];
  slabs: { band: string; maxGrams: number; priceCents: number }[];
  surcharges: { code: string; label: string; kind: "flat" | "percent"; amount: number; mode: "always" | "on_request" }[];
};

/** Typed draft → API payload, or the first sentence that explains why not. */
function toPayload(d: DocDraft): { payload: SavePayload } | { error: string } {
  const int = (raw: string, what: string): number | string => {
    if (!/^\d+$/.test(raw.trim())) return `${what} must be a whole number.`;
    return Number(raw.trim());
  };
  const divisor = int(d.volumetricDivisor, "Volumetric divisor");
  if (typeof divisor === "string") return { error: divisor };
  const rounding = int(d.roundingGrams, "Rounding step");
  if (typeof rounding === "string") return { error: rounding };
  const bands: SavePayload["bands"] = [];
  for (const b of d.bands) {
    const c = rupeesToCents(b.extraPerKg);
    if ("error" in c) return { error: `Band ${b.band || "(unnamed)"} per-kg: ${c.error}` };
    bands.push({ band: b.band.trim(), label: b.label.trim(), extraPerKgCents: c.cents });
  }
  const slabs: SavePayload["slabs"] = [];
  for (const s of d.slabs) {
    const g = int(s.maxGrams, `A ${s.band} slab's weight limit`);
    if (typeof g === "string") return { error: g };
    const c = rupeesToCents(s.price);
    if ("error" in c) return { error: `Slab ${s.band} up to ${s.maxGrams} g: ${c.error}` };
    slabs.push({ band: s.band, maxGrams: g, priceCents: c.cents });
  }
  const surcharges: SavePayload["surcharges"] = [];
  for (const s of d.surcharges) {
    const c = rupeesToCents(s.amount);
    if ("error" in c) return { error: `Surcharge ${s.code || "(unnamed)"}: ${c.error.replace("rupees", s.kind === "percent" ? "percent" : "rupees")}` };
    surcharges.push({ code: s.code.trim(), label: s.label.trim(), kind: s.kind, amount: c.cents, mode: s.mode });
  }
  return {
    payload: {
      volumetricDivisor: divisor,
      roundingGrams: rounding,
      note: d.note.trim() || null,
      bands,
      slabs,
      surcharges,
    },
  };
}

export function VersionPanel({ versionId, isAdmin, onGone }: { versionId: string; isAdmin: boolean; onGone: () => void }) {
  const doc = useRateCardVersion(versionId);
  if (doc.isLoading) return <p className="text-[13px] text-muted-foreground">Loading version…</p>;
  if (doc.error) return <ErrorNote>{apiMessage(doc.error, "This version is unavailable.")}</ErrorNote>;
  const data = doc.data!;
  const editable = isAdmin && data.version.status === "draft";
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {editable ? <DraftEditor doc={data} onGone={onGone} /> : <ReadOnlyVersion doc={data} />}
      <QuotePreview doc={data} />
    </div>
  );
}

function VersionHeader({ doc }: { doc: RateCardVersionDoc }) {
  const v = doc.version;
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono">v{v.version}</span>
      <Badge variant={v.status === "active" ? "good" : v.status === "draft" ? "brand" : "muted"}>{v.status}</Badge>
    </span>
  );
}

function ReadOnlyVersion({ doc }: { doc: RateCardVersionDoc }) {
  const v = doc.version;
  return (
    <Card
      title={<VersionHeader doc={doc} />}
      description={`Updated ${dateTime(v.updatedAt)}${v.updatedByName ? ` by ${v.updatedByName}` : ""}${v.status !== "draft" ? " · frozen" : ""}`}
    >
      <div className="flex flex-col gap-5 text-[13px]">
        <p className="text-muted-foreground">
          Volumetric divisor <span className="font-mono text-foreground">{v.volumetricDivisor}</span> cm³/kg · rounded up to{" "}
          <span className="font-mono text-foreground">{v.roundingGrams} g</span>
        </p>
        {v.note ? <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-[12px]">{v.note}</p> : null}
        {doc.bands.map((b) => (
          <div key={b.band}>
            <h4 className="font-medium">
              {b.label} <span className="font-mono text-[11px] text-muted-foreground">{b.band}</span>
            </h4>
            <table className="mt-2 w-full max-w-md text-[12px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-normal">Up to</th>
                  <th className="py-1 text-right font-normal">Price</th>
                </tr>
              </thead>
              <tbody>
                {doc.slabs
                  .filter((s) => s.band === b.band)
                  .map((s) => (
                    <tr key={s.maxGrams} className="border-t border-border">
                      <td className="py-1 font-mono">{grams(s.maxGrams)}</td>
                      <td className="py-1 text-right font-mono">{money(s.priceCents)}</td>
                    </tr>
                  ))}
                <tr className="border-t border-border text-muted-foreground">
                  <td className="py-1">Each started kg above</td>
                  <td className="py-1 text-right font-mono">{money(b.extraPerKgCents)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
        <div>
          <h4 className="font-medium">Surcharges</h4>
          <ul className="mt-2 flex flex-col gap-1 text-[12px]">
            {doc.surcharges.map((s) => (
              <li key={s.code} className="flex items-center gap-2">
                <span className="font-mono text-muted-foreground">{s.code}</span>
                <span>{s.label}</span>
                <span className="ml-auto font-mono">
                  {s.kind === "flat" ? money(s.amount) : `${centsToRupees(s.amount)}%`}
                </span>
                <Badge variant="outline">{s.mode === "always" ? "Always" : "On request"}</Badge>
              </li>
            ))}
            {doc.surcharges.length === 0 ? <li className="text-muted-foreground">None.</li> : null}
          </ul>
        </div>
      </div>
    </Card>
  );
}

function DraftEditor({ doc, onGone }: { doc: RateCardVersionDoc; onGone: () => void }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<DocDraft>(() => toDraft(doc));
  const [saved, setSaved] = React.useState<DocDraft>(() => toDraft(doc));
  const [problems, setProblems] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const built = toPayload(draft);

  const save = useMutation({
    ...orpc.rateCards.saveDraft.mutationOptions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      const next = toDraft(result);
      setDraft(next);
      setSaved(next);
      setProblems(result.problems);
      setSuccess(result.problems.length ? null : "Draft saved. It is ready to publish.");
    },
    onError: (e) => setError(apiMessage(e, "The draft could not be saved.")),
  });
  const publish = useMutation({
    ...orpc.rateCards.publish.mutationOptions(),
    onSuccess: (result) => {
      setPublishing(false);
      void queryClient.invalidateQueries();
      setSuccess(`Version ${result.version} is live${result.superseded ? `; v${result.superseded.version} is superseded` : ""}.`);
    },
    onError: (e) => {
      setPublishing(false);
      setError(apiMessage(e, "The draft could not be published."));
    },
  });
  const discard = useMutation({
    ...orpc.rateCards.discard.mutationOptions(),
    onSuccess: () => {
      setDiscarding(false);
      void queryClient.invalidateQueries();
      onGone();
    },
    onError: (e) => {
      setDiscarding(false);
      setError(apiMessage(e, "The draft could not be discarded."));
    },
  });

  const update = (fn: (d: DocDraft) => DocDraft) => {
    setSuccess(null);
    setDraft(fn);
  };
  const bandCodes = draft.bands.map((b) => b.band).filter(Boolean);

  return (
    <Card
      title={<VersionHeader doc={doc} />}
      description={`Draft · last saved ${dateTime(doc.version.updatedAt)}${doc.version.updatedByName ? ` by ${doc.version.updatedByName}` : ""}`}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setDiscarding(true)}>
            Discard draft
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || "error" in built}
            pending={save.isPending}
            onClick={() => {
              setError(null);
              if ("payload" in built) save.mutate({ versionId: doc.version.id, ...built.payload });
            }}
          >
            Save draft
          </Button>
          <Button
            size="sm"
            disabled={dirty || (problems?.length ?? 0) > 0}
            onClick={() => {
              setError(null);
              setReason("");
              setPublishing(true);
            }}
          >
            Publish
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {"error" in built ? <ErrorNote>{built.error}</ErrorNote> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {success ? <SuccessNote>{success}</SuccessNote> : null}
        {problems && problems.length ? (
          <ErrorNote>
            <span className="block font-medium">Saved, but not publishable yet:</span>
            {problems.map((p) => (
              <span key={p} className="mt-0.5 block">
                · {p}
              </span>
            ))}
          </ErrorNote>
        ) : null}
        {dirty ? <p className="text-[12px] text-status-warn">Unsaved changes — save before publishing or quoting.</p> : null}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Field label="Volumetric divisor" hint="cm³ per kg; L×W×H ÷ this = kg.">
            <Input
              value={draft.volumetricDivisor}
              inputMode="numeric"
              className="font-mono"
              onChange={(e) => update((d) => ({ ...d, volumetricDivisor: e.target.value }))}
            />
          </Field>
          <Field label="Round up to (g)" hint="Chargeable weight step.">
            <Input
              value={draft.roundingGrams}
              inputMode="numeric"
              className="font-mono"
              onChange={(e) => update((d) => ({ ...d, roundingGrams: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Note" hint="Where these numbers came from. Shown on every version view.">
          <Textarea value={draft.note} onChange={(e) => update((d) => ({ ...d, note: e.target.value }))} />
        </Field>

        <section aria-labelledby="bands-h" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 id="bands-h" className="font-display text-[14px] font-semibold">
              Bands
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() => update((d) => ({ ...d, bands: [...d.bands, { band: "", label: "", extraPerKg: "0.00" }] }))}
            >
              <Plus aria-hidden />
              Add band
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            A band is a delivery distance class (the zone structure is §15 q3 and still open). The per-kg rate prices
            weight above the heaviest slab.
          </p>
          {draft.bands.map((b, i) => (
            <div key={i} className="grid grid-cols-[140px_1fr_140px_auto] items-end gap-2">
              <Field label={i === 0 ? "Code" : ""}>
                <Input
                  aria-label={`Band ${i + 1} code`}
                  value={b.band}
                  className="font-mono"
                  onChange={(e) => {
                    const next = e.target.value.toLowerCase();
                    update((d) => ({
                      ...d,
                      bands: d.bands.map((x, j) => (j === i ? { ...x, band: next } : x)),
                      slabs: d.slabs.map((s) => (s.band === b.band ? { ...s, band: next } : s)),
                    }));
                  }}
                />
              </Field>
              <Field label={i === 0 ? "Label" : ""}>
                <Input
                  aria-label={`Band ${i + 1} label`}
                  value={b.label}
                  onChange={(e) =>
                    update((d) => ({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Field label={i === 0 ? "Per extra kg (Rs.)" : ""}>
                <Input
                  aria-label={`Band ${i + 1} per extra kg in rupees`}
                  value={b.extraPerKg}
                  className="font-mono"
                  inputMode="decimal"
                  onChange={(e) =>
                    update((d) => ({ ...d, bands: d.bands.map((x, j) => (j === i ? { ...x, extraPerKg: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove band ${b.band || i + 1}`}
                disabled={draft.bands.length <= 1}
                onClick={() =>
                  update((d) => ({
                    ...d,
                    bands: d.bands.filter((_, j) => j !== i),
                    slabs: d.slabs.filter((s) => s.band !== b.band),
                  }))
                }
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </section>

        <section aria-labelledby="slabs-h" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 id="slabs-h" className="font-display text-[14px] font-semibold">
              Weight slabs
            </h3>
            <Button
              variant="outline"
              size="sm"
              disabled={bandCodes.length === 0}
              onClick={() =>
                update((d) => ({ ...d, slabs: [...d.slabs, { band: bandCodes[0] ?? "", maxGrams: "", price: "" }] }))
              }
            >
              <Plus aria-hidden />
              Add slab
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Price for a parcel whose rounded chargeable weight is at most the limit. Heavier slabs may not cost less.
          </p>
          {draft.slabs.length === 0 ? <p className="text-[13px] text-muted-foreground">No slab yet — a band without slabs cannot be published.</p> : null}
          {draft.slabs.map((s, i) => (
            <div key={i} className="grid grid-cols-[160px_140px_140px_auto] items-end gap-2">
              <Field label={i === 0 ? "Band" : ""}>
                <Select
                  aria-label={`Slab ${i + 1} band`}
                  value={s.band}
                  onChange={(e) =>
                    update((d) => ({ ...d, slabs: d.slabs.map((x, j) => (j === i ? { ...x, band: e.target.value } : x)) }))
                  }
                >
                  {bandCodes.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={i === 0 ? "Up to (g)" : ""}>
                <Input
                  aria-label={`Slab ${i + 1} weight limit in grams`}
                  value={s.maxGrams}
                  className="font-mono"
                  inputMode="numeric"
                  onChange={(e) =>
                    update((d) => ({ ...d, slabs: d.slabs.map((x, j) => (j === i ? { ...x, maxGrams: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Field label={i === 0 ? "Price (Rs.)" : ""}>
                <Input
                  aria-label={`Slab ${i + 1} price in rupees`}
                  value={s.price}
                  className="font-mono"
                  inputMode="decimal"
                  onChange={(e) =>
                    update((d) => ({ ...d, slabs: d.slabs.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove slab ${i + 1}`}
                onClick={() => update((d) => ({ ...d, slabs: d.slabs.filter((_, j) => j !== i) }))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </section>

        <section aria-labelledby="sur-h" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 id="sur-h" className="font-display text-[14px] font-semibold">
              Surcharges
            </h3>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                update((d) => ({
                  ...d,
                  surcharges: [...d.surcharges, { code: "", label: "", kind: "flat", amount: "0.00", mode: "on_request" }],
                }))
              }
            >
              <Plus aria-hidden />
              Add surcharge
            </Button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Flat amounts are rupees; percentages apply to freight. There is no COD fee: it is bundled into the delivery
            rate.
          </p>
          {draft.surcharges.map((s, i) => (
            <div key={i} className="grid grid-cols-[130px_1fr_110px_110px_130px_auto] items-end gap-2">
              <Field label={i === 0 ? "Code" : ""}>
                <Input
                  aria-label={`Surcharge ${i + 1} code`}
                  value={s.code}
                  className="font-mono"
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      surcharges: d.surcharges.map((x, j) => (j === i ? { ...x, code: e.target.value.toLowerCase() } : x)),
                    }))
                  }
                />
              </Field>
              <Field label={i === 0 ? "Label" : ""}>
                <Input
                  aria-label={`Surcharge ${i + 1} label`}
                  value={s.label}
                  onChange={(e) =>
                    update((d) => ({ ...d, surcharges: d.surcharges.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Field label={i === 0 ? "Kind" : ""}>
                <Select
                  aria-label={`Surcharge ${i + 1} kind`}
                  value={s.kind}
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      surcharges: d.surcharges.map((x, j) => (j === i ? { ...x, kind: e.target.value as "flat" | "percent" } : x)),
                    }))
                  }
                >
                  <option value="flat">Flat Rs.</option>
                  <option value="percent">% freight</option>
                </Select>
              </Field>
              <Field label={i === 0 ? "Amount" : ""}>
                <Input
                  aria-label={`Surcharge ${i + 1} amount`}
                  value={s.amount}
                  className="font-mono"
                  inputMode="decimal"
                  onChange={(e) =>
                    update((d) => ({ ...d, surcharges: d.surcharges.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) }))
                  }
                />
              </Field>
              <Field label={i === 0 ? "Applies" : ""}>
                <Select
                  aria-label={`Surcharge ${i + 1} applies`}
                  value={s.mode}
                  onChange={(e) =>
                    update((d) => ({
                      ...d,
                      surcharges: d.surcharges.map((x, j) =>
                        j === i ? { ...x, mode: e.target.value as "always" | "on_request" } : x,
                      ),
                    }))
                  }
                >
                  <option value="always">Always</option>
                  <option value="on_request">On request</option>
                </Select>
              </Field>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove surcharge ${s.code || i + 1}`}
                onClick={() => update((d) => ({ ...d, surcharges: d.surcharges.filter((_, j) => j !== i) }))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
        </section>
      </div>

      <ConfirmDialog
        open={publishing}
        onOpenChange={setPublishing}
        title={`Publish v${doc.version.version}?`}
        objectName={`${doc.card.code} v${doc.version.version}`}
        destructive={false}
        confirmLabel="Publish"
        pending={publish.isPending}
        confirmDisabled={reason.trim().length < 5}
        body={
          <div className="flex flex-col gap-3">
            <p>
              This version becomes the live tariff for every merchant on {doc.card.code} and is frozen. The current live
              version, if any, is superseded. Parcels already priced keep their price.
            </p>
            {doc.card.placeholder ? (
              <p className="rounded-md border border-status-warn/40 bg-status-warn/10 px-3 py-2 text-[12px] text-status-warn">
                This card is a PLACEHOLDER (§15 q3 unanswered). Publishing does not make these prices approved.
              </p>
            ) : null}
            <Field label="Reason" hint="Recorded in the audit log. At least 5 characters.">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
        }
        onConfirm={() => publish.mutate({ versionId: doc.version.id, reason: reason.trim() })}
      />
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard this draft?"
        objectName={`${doc.card.code} v${doc.version.version}`}
        confirmLabel="Discard"
        pending={discard.isPending}
        body="The draft and its unpublished prices are deleted. The live version is not affected."
        onConfirm={() => discard.mutate({ versionId: doc.version.id })}
      />
    </Card>
  );
}

type QuoteIn = Parameters<typeof client.rateCards.quote>[0];

function QuotePreview({ doc }: { doc: RateCardVersionDoc }) {
  const [band, setBand] = React.useState(doc.bands[0]?.band ?? "");
  const [kg, setKg] = React.useState("1");
  const [dims, setDims] = React.useState({ l: "", w: "", h: "" });
  const [requested, setRequested] = React.useState<string[]>([]);
  const [asked, setAsked] = React.useState<QuoteIn | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const optional = doc.surcharges.filter((s) => s.mode === "on_request");

  const result = useQuery({
    ...orpc.rateCards.quote.queryOptions({ input: asked ?? { versionId: doc.version.id, band, weightGrams: 1, requested: [] } }),
    enabled: asked !== null,
    retry: false,
  });

  const run = () => {
    setProblem(null);
    const g = kgToGrams(kg);
    if ("error" in g) return setProblem(g.error);
    const dim = (v: string) => (v.trim() === "" ? null : Number(v));
    const l = dim(dims.l);
    const w = dim(dims.w);
    const h = dim(dims.h);
    for (const v of [l, w, h]) if (v !== null && (!Number.isInteger(v) || v < 1)) return setProblem("Dimensions are whole centimetres.");
    setAsked({ versionId: doc.version.id, band, weightGrams: g.grams, lengthCm: l, widthCm: w, heightCm: h, requested });
  };

  const q = result.data;
  return (
    <Card title="Quote preview" description={`Prices a parcel against v${doc.version.version} as saved. Read-only — nothing is booked.`}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="Band">
            <Select value={band} onChange={(e) => setBand(e.target.value)}>
              {doc.bands.map((b) => (
                <option key={b.band} value={b.band}>
                  {b.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Weight (kg)">
            <Input value={kg} onChange={(e) => setKg(e.target.value)} inputMode="decimal" className="font-mono" />
          </Field>
          <Field label="L (cm)">
            <Input value={dims.l} onChange={(e) => setDims((d) => ({ ...d, l: e.target.value }))} inputMode="numeric" className="font-mono" />
          </Field>
          <Field label="W (cm)">
            <Input value={dims.w} onChange={(e) => setDims((d) => ({ ...d, w: e.target.value }))} inputMode="numeric" className="font-mono" />
          </Field>
          <Field label="H (cm)">
            <Input value={dims.h} onChange={(e) => setDims((d) => ({ ...d, h: e.target.value }))} inputMode="numeric" className="font-mono" />
          </Field>
        </div>
        {optional.length ? (
          <fieldset className="flex flex-wrap gap-4 text-[13px]">
            <legend className="label-xs mb-1 text-muted-foreground">Requested extras</legend>
            {optional.map((s) => (
              <label key={s.code} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={s.label}
                  checked={requested.includes(s.code)}
                  onChange={(e) =>
                    setRequested((r) => (e.target.checked ? [...r, s.code] : r.filter((c) => c !== s.code)))
                  }
                />
                {s.label}
              </label>
            ))}
          </fieldset>
        ) : null}
        <Button className="w-fit" variant="outline" onClick={run} pending={result.isFetching} disabled={!band}>
          Quote
        </Button>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
        {result.error ? <ErrorNote>{apiMessage(result.error, "This parcel could not be priced.")}</ErrorNote> : null}
        {q && asked ? (
          <div className="rounded-md border border-border" data-testid="quote-result">
            <p className="border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
              Actual {grams(q.actualGrams)} · volumetric {grams(q.volumetricGrams)} · chargeable {grams(q.chargeableGrams)} → rounded{" "}
              {grams(q.roundedGrams)}
            </p>
            <table className="w-full text-[13px]">
              <tbody>
                {q.lines.map((l) => (
                  <tr key={l.code} className="border-b border-border">
                    <td className="px-3 py-1.5">
                      {l.label}
                      <span className="ml-2 text-[11px] text-muted-foreground">{l.detail}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{money(l.amountCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="px-3 py-2 font-semibold">Total</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold" data-testid="quote-total">
                    {money(q.totalCents)}
                  </td>
                </tr>
              </tbody>
            </table>
            {q.rateCard.placeholder ? (
              <p className="border-t border-border px-3 py-2 text-[12px] text-status-warn">Placeholder tariff — not a real price.</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
