import * as React from "react";
import { Ban, FilePlus2, Plus, ReceiptText, RotateCcw, Send, Trash2, Wallet } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees, rupeesToCents } from "@/lib/csv";
import { useDebounced } from "@/lib/hooks";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import {
  useArAgeing,
  useCreateInvoice,
  useInvoice,
  useInvoicePage,
  useInvoicePreview,
  useIssueCreditNote,
  useIssueInvoice,
  useRecordInvoicePayment,
  useVoidInvoice,
  type FinanceIn,
  type FinanceOut,
} from "@/queries/finance";
import {
  EXPORT_PAGE,
  Figure,
  MerchantSelect,
  Notes,
  PAGE_SIZE,
  RupeeInput,
  SectionTitle,
  StatusBadge,
  useCanWriteMoney,
  useRupees,
} from "./shared";

/**
 * Merchant invoicing (§10 M4 "invoicing with VAT/SSCL, credit notes, AR
 * ageing").
 *
 * An invoice bills what NatEx is owed for the period — fees not already
 * recovered from COD — plus any manual charges. Tax is computed by the server
 * from the finance config; the screen only shows it. An issued invoice is
 * never edited: it is credited, paid or (only while nothing has touched it)
 * voided.
 */

type Invoice = FinanceOut<"invoicePage">["rows"][number];
type InvoiceStatus = NonNullable<FinanceIn<"invoicePage">["status"]>[number];
type Charge = NonNullable<FinanceIn<"invoicePreview">["charges"]>[number];

const STATUSES: InvoiceStatus[] = ["draft", "issued", "part_paid", "paid", "void"];
const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export function InvoicesTab() {
  const canWrite = useCanWriteMoney();
  const [status, setStatus] = React.useState<"" | InvoiceStatus | "open">("open");
  const [merchantId, setMerchantId] = React.useState("");
  const [q, setQ] = React.useState("");
  const debouncedQ = useDebounced(q.trim(), 300);
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  React.useEffect(() => setPage(1), [status, merchantId, debouncedQ]);

  const filter: { status?: InvoiceStatus[]; merchantId?: string; q?: string } = {
    status: status === "open" ? ["draft", "issued", "part_paid"] : status ? [status] : undefined,
    merchantId: merchantId || undefined,
    q: debouncedQ || undefined,
  };
  const list = useInvoicePage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];

  const columns: Column<Invoice>[] = [
    { key: "code", header: "Invoice", width: "w-[160px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "merchant", header: "Merchant", cell: (r) => r.merchantName },
    { key: "period", header: "Period", width: "w-[190px]", className: "text-[12px]", cell: (r) => `${date(r.periodStart)} – ${date(r.periodEnd)}` },
    { key: "due", header: "Due", width: "w-[110px]", className: "text-[12px]", cell: (r) => date(r.dueDate) },
    { key: "status", header: "Status", width: "w-[110px]", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "total", header: "Total", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.totalCents) },
    { key: "paid", header: "Paid", align: "right", width: "w-[110px]", className: "font-mono text-[12px]", cell: (r) => amount(r.paidCents) },
    { key: "credited", header: "Credited", align: "right", width: "w-[110px]", className: "font-mono text-[12px]", cell: (r) => amount(r.creditedCents) },
    {
      key: "owed",
      header: "Outstanding",
      align: "right",
      width: "w-[130px]",
      className: "font-mono font-medium",
      cell: (r) => (r.status === "void" || r.status === "draft" ? "—" : amount(r.totalCents - r.paidCents - r.creditedCents)),
    },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Invoices could not be loaded." : null}
        emptyTitle="No invoices match"
        emptyDescription={status === "open" ? "Nothing is drafted or awaiting payment." : undefined}
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[200px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Invoice status">
                <option value="open">Open (draft, issued, part paid)</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
                <option value="">All</option>
              </Select>
            </Field>
            <Field label="Merchant" className="w-[220px]">
              <MerchantSelect value={merchantId} onChange={setMerchantId} allLabel="All merchants" />
            </Field>
            <Field label="Search" className="w-[200px]">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Invoice code" aria-label="Search invoices" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("open");
                setMerchantId("");
                setQ("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {canWrite ? (
                <Button size="sm" onClick={() => setDrafting(true)}>
                  <FilePlus2 aria-hidden />
                  Draft invoice
                </Button>
              ) : null}
              <ExportCsvButton<Invoice>
                filename={`natex-invoices-${colomboToday()}.csv`}
                header={["code", "merchant_id", "merchant", "vat_no", "period_start", "period_end", "due_date", "status", "subtotal_lkr", "sscl_lkr", "vat_lkr", "total_lkr", "paid_lkr", "credited_lkr", "recovered_lkr", "issued_at", "void_reason"]}
                toRow={(r) => [
                  r.code,
                  r.merchantId,
                  r.merchantName,
                  r.merchantVatNo ?? "",
                  r.periodStart,
                  r.periodEnd,
                  r.dueDate,
                  r.status,
                  centsToRupees(r.subtotalCents),
                  centsToRupees(r.ssclCents),
                  centsToRupees(r.vatCents),
                  centsToRupees(r.totalCents),
                  centsToRupees(r.paidCents),
                  centsToRupees(r.creditedCents),
                  centsToRupees(r.recoveredCents),
                  r.issuedAt ? dateTime(r.issuedAt) : "",
                  r.voidReason ?? "",
                ]}
                fetchPage={(p) => client.finance.invoicePage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
              />
            </div>
          </>
        }
      />
      <InvoiceDrawer invoiceId={openId} canWrite={canWrite} onClose={() => setOpenId(null)} />
      <NewInvoiceDrawer
        open={drafting}
        onClose={() => setDrafting(false)}
        onCreated={(id) => {
          setDrafting(false);
          setOpenId(id);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── one invoice

type InvoiceAction = "issue" | "pay" | "credit" | "void";

function InvoiceDrawer({ invoiceId, canWrite, onClose }: { invoiceId: string | null; canWrite: boolean; onClose: () => void }) {
  const detail = useInvoice(invoiceId);
  const inv = detail.data?.invoice;
  const [action, setAction] = React.useState<InvoiceAction | null>(null);
  const rupees = useRupees();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const { setText: setRupees } = rupees;

  React.useEffect(() => {
    setAction(null);
    setText("");
    setRupees("");
    setError(null);
    setDone(null);
  }, [invoiceId, setRupees]);

  const begin = (a: InvoiceAction) => {
    setError(null);
    setDone(null);
    setText("");
    setRupees(a === "pay" && detail.data ? centsToRupees(detail.data.outstandingCents) : "");
    setAction(a);
  };
  const ok = (message: string) => {
    setAction(null);
    setError(null);
    setDone(message);
  };
  const fail = (m: string) => {
    setAction(null);
    setDone(null);
    setError(m);
  };
  const issue = useIssueInvoice({ onSuccess: (r) => ok(`${r.code} issued. Due ${date(r.dueDate)}.`), onError: fail });
  const pay = useRecordInvoicePayment({
    onSuccess: (r) => ok(`Payment recorded. ${r.invoice.code} is now ${humanise(r.invoice.status)}.`),
    onError: fail,
  });
  const credit = useIssueCreditNote({
    onSuccess: (r) => ok(`Credit note ${r.creditNote.code} for ${money(r.creditNote.amountCents)} issued.`),
    onError: fail,
  });
  const voider = useVoidInvoice({ onSuccess: (r) => ok(`${r.code} voided. The period can be invoiced again.`), onError: fail });
  const pending = issue.isPending || pay.isPending || credit.isPending || voider.isPending;

  const outstanding = detail.data?.outstandingCents ?? 0;
  const live = inv && (inv.status === "issued" || inv.status === "part_paid");

  const valid =
    action === "issue"
      ? true
      : action === "pay"
        ? rupees.cents !== null && rupees.cents > 0 && text.trim().length > 0
        : action === "credit"
          ? rupees.cents !== null && rupees.cents > 0 && text.trim().length >= 3
          : action === "void"
            ? text.trim().length >= 3
            : false;

  const run = () => {
    if (!inv) return;
    if (action === "issue") issue.mutate({ invoiceId: inv.id });
    else if (action === "pay" && rupees.cents) pay.mutate({ invoiceId: inv.id, amountCents: rupees.cents, reference: text.trim() });
    else if (action === "credit" && rupees.cents) credit.mutate({ invoiceId: inv.id, amountCents: rupees.cents, reason: text.trim() });
    else if (action === "void") voider.mutate({ invoiceId: inv.id, reason: text.trim() });
  };

  const COPY: Record<InvoiceAction, { title: string; label: string; body: string; destructive: boolean }> = {
    issue: { title: "Issue this invoice?", label: "Issue", body: "The merchant owes it from now and the credit-term clock starts. An issued invoice can no longer be edited.", destructive: false },
    pay: { title: "Record a payment?", label: "Record payment", body: `Outstanding is ${money(outstanding)}. A payment larger than that is refused.`, destructive: false },
    credit: { title: "Issue a credit note?", label: "Issue credit note", body: `The credit reduces what the merchant owes on this invoice (outstanding ${money(outstanding)}). Credit notes are permanent.`, destructive: true },
    void: { title: "Void this invoice?", label: "Void", body: "Voiding is only allowed while nothing has been paid or credited. The period is released and can be invoiced again.", destructive: true },
  };

  return (
    <Drawer
      open={Boolean(invoiceId)}
      onOpenChange={(next) => !next && onClose()}
      title={inv?.code ?? "Invoice"}
      subtitle={inv ? `${inv.merchantName} · ${date(inv.periodStart)} – ${date(inv.periodEnd)}` : undefined}
    >
      {detail.isError ? <ErrorNote>This invoice could not be loaded.</ErrorNote> : null}
      {inv && detail.data ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={inv.status} />
            {detail.data.balanced ? <Badge variant="good">lines balance</Badge> : <Badge variant="bad">header ≠ lines</Badge>}
          </div>
          <section className="grid grid-cols-4 gap-3 rounded-md border p-3">
            <Figure label="Subtotal" cents={inv.subtotalCents} />
            <Figure label="SSCL" cents={inv.ssclCents} />
            <Figure label="VAT" cents={inv.vatCents} />
            <Figure label="Total" cents={inv.totalCents} />
            <Figure label="Paid" cents={inv.paidCents} tone={inv.paidCents ? "good" : undefined} />
            <Figure label="Credited" cents={inv.creditedCents} />
            <Figure label="Recovered from COD" cents={inv.recoveredCents} hint="Already deducted in settlement" />
            <Figure label="Outstanding" cents={outstanding} tone={outstanding > 0 && live ? "warn" : undefined} />
          </section>
          <KeyValueGrid>
            <KeyValue label="Due">{date(inv.dueDate)}</KeyValue>
            <KeyValue label="Issued" mono>{inv.issuedAt ? dateTime(inv.issuedAt) : "—"}</KeyValue>
            <KeyValue label="Merchant VAT no." mono>{inv.merchantVatNo ?? "—"}</KeyValue>
            {inv.voidReason ? <KeyValue label="Void reason" className="col-span-2">{inv.voidReason}</KeyValue> : null}
          </KeyValueGrid>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {canWrite && inv.status !== "void" ? (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {inv.status === "draft" ? (
                <Button size="sm" onClick={() => begin("issue")}>
                  <Send aria-hidden />
                  Issue
                </Button>
              ) : null}
              {live ? (
                <Button size="sm" onClick={() => begin("pay")}>
                  <Wallet aria-hidden />
                  Record payment
                </Button>
              ) : null}
              {live ? (
                <Button size="sm" variant="outline" onClick={() => begin("credit")}>
                  <ReceiptText aria-hidden />
                  Credit note
                </Button>
              ) : null}
              {inv.paidCents === 0 && inv.creditedCents === 0 ? (
                <Button size="sm" variant="destructive" onClick={() => begin("void")}>
                  <Ban aria-hidden />
                  Void
                </Button>
              ) : null}
            </div>
          ) : null}

          <section className="space-y-2">
            <SectionTitle>Lines ({detail.data.lines.length})</SectionTitle>
            <div className="max-h-[300px] overflow-auto rounded-md border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Description</th>
                    <th className="px-3 py-1.5 font-medium">AWB</th>
                    <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rs.</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.lines.map((l) => (
                    <tr key={l.id} className="border-t">
                      <td className="px-3 py-1.5">
                        {l.description}
                        {l.recovered ? <span className="ml-1.5 text-muted-foreground">(recovered)</span> : null}
                        {!l.taxable ? <span className="ml-1.5 text-muted-foreground">(no tax)</span> : null}
                      </td>
                      <td className="px-3 py-1.5 font-mono">{l.awb ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{l.quantity}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{amount(l.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {detail.data.creditNotes.length > 0 ? (
            <section className="space-y-2">
              <SectionTitle>Credit notes</SectionTitle>
              <ul className="space-y-1 text-[12px]">
                {detail.data.creditNotes.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3 rounded-md border px-3 py-1.5">
                    <span>
                      <span className="font-mono">{c.code}</span> · {c.reason}
                      {c.disputeId ? <span className="text-muted-foreground"> · dispute</span> : null}
                    </span>
                    <span className="font-mono">{money(c.amountCents)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {action ? (
            <ConfirmDialog
              open
              onOpenChange={(o) => !o && setAction(null)}
              title={COPY[action].title}
              objectName={inv.code}
              destructive={COPY[action].destructive}
              confirmLabel={COPY[action].label}
              pending={pending}
              confirmDisabled={!valid}
              body={
                <div className="space-y-3">
                  <p>{COPY[action].body}</p>
                  {action === "pay" || action === "credit" ? (
                    <Field label="Amount (Rs.)" error={rupees.error ?? undefined}>
                      <RupeeInput value={rupees.text} onChange={rupees.setText} label="Amount in rupees" />
                    </Field>
                  ) : null}
                  {action === "pay" ? (
                    <Field label="Bank reference (required)">
                      <Input value={text} onChange={(e) => setText(e.target.value)} className="font-mono" aria-label="Bank reference" placeholder="HNB-TRF-88120" />
                    </Field>
                  ) : null}
                  {action === "credit" || action === "void" ? (
                    <Field label="Reason (required)">
                      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
                    </Field>
                  ) : null}
                </div>
              }
              onConfirm={run}
            />
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── new invoice

type ChargeDraft = { key: number; description: string; rupees: string; quantity: string; awb: string; taxable: boolean };

function NewInvoiceDrawer({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [merchantId, setMerchantId] = React.useState("");
  const [drafts, setDrafts] = React.useState<ChargeDraft[]>([]);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const nextKey = React.useRef(1);
  React.useEffect(() => {
    if (!open) return;
    setMerchantId("");
    setDrafts([]);
    setConfirm(false);
    setError(null);
  }, [open]);

  const parsed = drafts.map((d) => {
    const unit = d.rupees.trim() ? rupeesToCents(d.rupees) : null;
    const cents = unit && "cents" in unit ? unit.cents : null;
    const qty = d.quantity.trim() === "" ? 1 : Number(d.quantity);
    const qtyOk = Number.isInteger(qty) && qty > 0;
    return {
      d,
      cents,
      qty,
      unitError: unit && "error" in unit ? unit.error : null,
      qtyError: qtyOk ? null : "A whole number above zero.",
      complete: cents !== null && cents > 0 && qtyOk && d.description.trim().length > 0,
    };
  });
  const charges: Charge[] = parsed
    .filter((p) => p.complete)
    .map((p) => ({
      description: p.d.description.trim(),
      unitCents: p.cents!,
      quantity: p.qty,
      awb: p.d.awb.trim() || undefined,
      taxable: p.d.taxable,
    }));
  const debounced = useDebounced(charges, 400);
  const preview = useInvoicePreview(merchantId ? { merchantId, charges: debounced.length ? debounced : undefined } : null);
  const p = preview.data;
  const incomplete = parsed.some((x) => !x.complete);

  const create = useCreateInvoice({
    onSuccess: (r) => {
      setConfirm(false);
      onCreated(r.invoice.id);
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });
  const update = (key: number, patch: Partial<ChargeDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title="Draft an invoice" subtitle="Fees for the current period are derived from the ledger; add manual charges if needed.">
      <div className="space-y-5">
        <Field label="Merchant">
          <MerchantSelect value={merchantId} onChange={setMerchantId} />
        </Field>
        {merchantId ? (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <SectionTitle>Manual charges</SectionTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDrafts((prev) => [...prev, { key: nextKey.current++, description: "", rupees: "", quantity: "1", awb: "", taxable: true }])
                  }
                >
                  <Plus aria-hidden />
                  Add charge
                </Button>
              </div>
              {parsed.map(({ d, unitError, qtyError }, index) => (
                <div key={d.key} className="grid grid-cols-[1fr_110px_80px_auto] gap-2 rounded-md border p-3">
                  <Field label="Description">
                    <Input value={d.description} onChange={(e) => update(d.key, { description: e.target.value })} aria-label={`Charge ${index + 1} description`} placeholder="Packaging material, 40 flyers" />
                  </Field>
                  <Field label="Unit Rs." error={unitError ?? undefined}>
                    <RupeeInput value={d.rupees} onChange={(v) => update(d.key, { rupees: v })} label={`Charge ${index + 1} unit price in rupees`} />
                  </Field>
                  <Field label="Qty" error={qtyError ?? undefined}>
                    <Input value={d.quantity} onChange={(e) => update(d.key, { quantity: e.target.value })} inputMode="numeric" className="font-mono" aria-label={`Charge ${index + 1} quantity`} />
                  </Field>
                  <div className="flex items-end">
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove charge ${index + 1}`} onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <Field label="AWB (optional)">
                    <Input value={d.awb} onChange={(e) => update(d.key, { awb: e.target.value })} className="font-mono" aria-label={`Charge ${index + 1} AWB`} />
                  </Field>
                  <label className="col-span-3 flex items-end gap-2 pb-2 text-[13px]">
                    <input
                      type="checkbox"
                      aria-label={`Charge ${index + 1} is taxable`}
                      checked={d.taxable}
                      onChange={(e) => update(d.key, { taxable: e.target.checked })}
                      className="size-4 accent-[var(--color-brand)]"
                    />
                    Taxable (VAT/SSCL apply)
                  </label>
                </div>
              ))}
            </section>

            {preview.isError ? <ErrorNote>The preview could not be computed.</ErrorNote> : null}
            {p ? (
              <section className="space-y-3 border-t pt-4">
                <SectionTitle>
                  Preview · {date(p.period.periodStart)} – {date(p.period.periodEnd)} · due {date(p.dueDate)}
                </SectionTitle>
                <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
                  <Figure label="Subtotal" cents={p.subtotalCents} />
                  <Figure label="SSCL" cents={p.ssclCents} />
                  <Figure label="VAT" cents={p.vatCents} />
                  <Figure label="Total" cents={p.totalCents} />
                  <Figure label="Recovered from COD" cents={p.recoveredCents} />
                  <Figure label="Receivable" cents={p.receivableCents} />
                </div>
                <p className="text-[12px] text-muted-foreground">{p.lines.length} line(s).</p>
                <Notes notes={p.notes} />
              </section>
            ) : preview.isFetching ? (
              <p className="text-[12px] text-muted-foreground">Computing preview…</p>
            ) : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="flex items-center gap-2 border-t pt-4">
              <Button disabled={!p || incomplete || p.lines.length === 0} onClick={() => setConfirm(true)}>
                <FilePlus2 aria-hidden />
                Create draft
              </Button>
              {incomplete ? <p className="text-[12px] text-muted-foreground">Finish or remove the incomplete charge first.</p> : null}
              {p && p.lines.length === 0 ? <p className="text-[12px] text-muted-foreground">There is nothing to invoice for this period.</p> : null}
            </div>
          </>
        ) : null}
        <ConfirmDialog
          open={confirm}
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Create this invoice draft?"
          objectName={p?.merchantName ?? merchantId}
          destructive={false}
          confirmLabel={p ? `Draft ${money(p.totalCents)}` : "Draft"}
          pending={create.isPending}
          body="The draft reserves these charges so they cannot be billed twice. It is not owed until it is issued."
          onConfirm={() => create.mutate({ merchantId, charges: charges.length ? charges : undefined })}
        />
      </div>
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── AR ageing

export function ArAgeingTab() {
  const ar = useArAgeing();
  const data = ar.data;
  type Row = NonNullable<typeof data>["rows"][number];
  const columns: Column<Row>[] = [
    { key: "merchant", header: "Merchant", cell: (r) => r.merchantName },
    { key: "count", header: "Invoices", align: "right", width: "w-[90px]", className: "font-mono text-[12px]", cell: (r) => r.invoiceCount },
    { key: "nyd", header: "Not yet due", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.notYetDueCents) },
    ...BUCKETS.map(
      (b): Column<Row> => ({
        key: b,
        header: `${b} days`,
        align: "right",
        width: "w-[110px]",
        className: `font-mono text-[12px] ${b === "90+" ? "text-status-bad" : ""}`,
        cell: (r) => (r.buckets[b] ? amount(r.buckets[b]) : "—"),
      }),
    ),
    { key: "total", header: "Outstanding", align: "right", width: "w-[130px]", className: "font-mono font-medium", cell: (r) => amount(r.outstandingCents) },
    { key: "oldest", header: "Oldest", align: "right", width: "w-[90px]", className: "font-mono text-[12px]", cell: (r) => (r.oldestDays > 0 ? `${r.oldestDays}d` : "—") },
  ];
  const rows = data?.rows ?? [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <MetricTile label="Outstanding" value={data ? money(data.outstandingCents) : "—"} hint={data ? `As of ${date(data.asOf)}` : undefined} />
        <MetricTile label="Not yet due" value={data ? money(data.notYetDueCents) : "—"} hint={data ? `${data.creditTermDays}-day terms` : undefined} />
        {BUCKETS.map((b) => (
          <MetricTile
            key={b}
            label={`${b} days past due`}
            value={data ? money(data.totals[b]) : "—"}
            accent={b === "90+" && data?.totals[b] ? "var(--status-bad)" : undefined}
          />
        ))}
      </div>
      {data ? <Notes notes={data.notes} /> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.merchantId}
        loading={ar.isPending}
        error={ar.isError ? "AR ageing could not be loaded." : null}
        emptyTitle="Nobody owes NatEx anything"
        emptyDescription="Every issued invoice is paid or credited."
        filters={
          <div className="ml-auto">
            <ExportCsvButton<Row>
              filename={`natex-ar-ageing-${colomboToday()}.csv`}
              header={["merchant_id", "merchant", "invoices", "not_yet_due_lkr", "d0_30_lkr", "d31_60_lkr", "d61_90_lkr", "d90_plus_lkr", "outstanding_lkr", "oldest_days"]}
              toRow={(r) => [
                r.merchantId,
                r.merchantName,
                r.invoiceCount,
                centsToRupees(r.notYetDueCents),
                ...BUCKETS.map((b) => centsToRupees(r.buckets[b])),
                centsToRupees(r.outstandingCents),
                r.oldestDays,
              ]}
              fetchPage={async () => ({ rows, total: rows.length, pageSize: Math.max(1, rows.length) })}
            />
          </div>
        }
      />
    </div>
  );
}
