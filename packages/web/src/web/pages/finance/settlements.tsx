import * as React from "react";
import { Link } from "wouter";
import { Ban, CheckCheck, FileDown, Hand, Plus, RotateCcw, Send, Trash2, Undo2, Wallet } from "lucide-react";
import { apiDetails, client } from "@/lib/api";
import { amount, colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees, rupeesToCents } from "@/lib/csv";
import { useUser } from "@/components/auth-provider";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { useDebounced } from "@/lib/hooks";
import {
  useApproveSettlement,
  useCreateSettlement,
  useCurrentPeriod,
  useExportPayoutCsv,
  useHoldSettlement,
  useProposeSettlement,
  useRecordPayout,
  useRejectSettlement,
  useReleaseSettlement,
  useSettlement,
  useSettlementDue,
  useSettlementPage,
  useSettlementPreview,
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
} from "./shared";

/**
 * Settlement runs (§8 checkpoints 4–5, §10 M4 "settlement runs with
 * maker–checker approval, payout file export, UTR").
 *
 * draft → proposed → approved → paid, with on_hold and rejected off to the
 * side. The person who drafted a run can never approve it: the server checks
 * that by user id and refuses with a 403, and this screen shows the refusal as
 * written rather than hiding the button — a checker needs to see *why* they
 * cannot act, not wonder where the button went.
 *
 * The payout file is a write: exporting stamps the runs exported, and a second
 * export of the same run is refused unless it is explicitly forced, because a
 * bank file uploaded twice pays a merchant twice.
 */

type Settlement = FinanceOut<"settlementPage">["rows"][number];
type SettlementStatus = NonNullable<FinanceIn<"settlementPage">["status"]>[number];
type Deduction = NonNullable<FinanceIn<"settlementPreview">["deductions"]>[number];
type DeductionType = Deduction["type"];

const STATUSES: SettlementStatus[] = ["draft", "proposed", "approved", "paid", "on_hold", "rejected"];
const DEDUCTION_TYPES: DeductionType[] = ["forwarding", "weight_discrepancy", "penalty", "adjustment"];

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SettlementsTab() {
  const canWrite = useCanWriteMoney();
  const [status, setStatus] = React.useState<"" | SettlementStatus | "pending">("pending");
  const [merchantId, setMerchantId] = React.useState("");
  const [q, setQ] = React.useState("");
  const debouncedQ = useDebounced(q.trim(), 300);
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setPage(1), [status, merchantId, debouncedQ]);

  const filter: { status?: SettlementStatus[]; merchantId?: string; q?: string } = {
    status:
      status === "pending"
        ? (["draft", "proposed", "approved", "on_hold"] as SettlementStatus[])
        : status
          ? [status]
          : undefined,
    merchantId: merchantId || undefined,
    q: debouncedQ || undefined,
  };
  const list = useSettlementPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const columns: Column<Settlement>[] = [
    ...(canWrite
      ? [
          {
            key: "pick",
            header: <span className="sr-only">Select for payout file</span>,
            width: "w-[40px]",
            cell: (r: Settlement) =>
              r.status === "approved" ? (
                <input
                  type="checkbox"
                  aria-label={`Include ${r.code} in the payout file`}
                  checked={selected.has(r.id)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                  onChange={(e) => toggle(r.id, e.target.checked)}
                  className="size-4 accent-[var(--color-brand)]"
                />
              ) : null,
          } satisfies Column<Settlement>,
        ]
      : []),
    { key: "code", header: "Run", width: "w-[160px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "merchant", header: "Merchant", cell: (r) => r.merchantName },
    {
      key: "period",
      header: "Period",
      width: "w-[190px]",
      className: "text-[12px]",
      cell: (r) => `${date(r.periodStart)} – ${date(r.periodEnd)}`,
    },
    { key: "payout", header: "Pays", width: "w-[110px]", className: "text-[12px]", cell: (r) => date(r.payoutDate) },
    { key: "status", header: "Status", width: "w-[120px]", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "gross", header: "Gross", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.grossCents) },
    { key: "ded", header: "Deductions", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.deductionsCents) },
    { key: "net", header: "Net", align: "right", width: "w-[130px]", className: "font-mono font-medium", cell: (r) => amount(r.netCents) },
    {
      key: "flags",
      header: "Bank",
      width: "w-[120px]",
      className: "text-[12px]",
      cell: (r) =>
        r.utr ? (
          <span className="font-mono">{r.utr}</span>
        ) : r.exportedAt ? (
          <Badge variant="outline">file sent</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      {canWrite ? <DueCard onDraft={setDrafting} /> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Settlement runs could not be loaded." : null}
        emptyTitle="No settlement runs match"
        emptyDescription={status === "pending" ? "Nothing is waiting to be proposed, approved or paid." : undefined}
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[200px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Settlement status">
                <option value="pending">In progress</option>
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
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Run code or UTR" aria-label="Search settlement runs" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("pending");
                setMerchantId("");
                setQ("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {canWrite ? <PayoutFileButton ids={[...selected]} onDone={() => setSelected(new Set())} /> : null}
              <ExportCsvButton<Settlement>
                filename={`natex-settlements-${colomboToday()}.csv`}
                header={["code", "merchant_id", "merchant", "period_start", "period_end", "payout_date", "status", "gross_lkr", "deductions_lkr", "net_lkr", "created_by", "approved_by", "utr", "paid_at", "exported_at", "hold_reason", "rejected_reason"]}
                toRow={(r) => [
                  r.code,
                  r.merchantId,
                  r.merchantName,
                  r.periodStart,
                  r.periodEnd,
                  r.payoutDate,
                  r.status,
                  centsToRupees(r.grossCents),
                  centsToRupees(r.deductionsCents),
                  centsToRupees(r.netCents),
                  r.createdByName,
                  r.approvedByName ?? "",
                  r.utr ?? "",
                  r.paidAt ? dateTime(r.paidAt) : "",
                  r.exportedAt ? dateTime(r.exportedAt) : "",
                  r.holdReason ?? "",
                  r.rejectedReason ?? "",
                ]}
                fetchPage={(p) => client.finance.settlementPage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
              />
            </div>
          </>
        }
      />
      <SettlementDrawer settlementId={openId} canWrite={canWrite} onClose={() => setOpenId(null)} />
      <NewSettlementDrawer
        merchantId={drafting}
        onClose={() => setDrafting(null)}
        onCreated={(id) => {
          setDrafting(null);
          setOpenId(id);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── due this period

function DueCard({ onDraft }: { onDraft: (merchantId: string) => void }) {
  const due = useSettlementDue();
  const period = useCurrentPeriod();
  const rows = due.data ?? [];
  type Due = (typeof rows)[number];
  const columns: Column<Due>[] = [
    { key: "merchant", header: "Merchant", cell: (r) => r.merchantName },
    { key: "parcels", header: "Parcels", align: "right", width: "w-[100px]", className: "font-mono text-[12px]", cell: (r) => r.parcelCount },
    { key: "gross", header: "Banked, unsettled", align: "right", width: "w-[160px]", className: "font-mono", cell: (r) => amount(r.grossCents) },
    {
      key: "go",
      header: <span className="sr-only">Draft</span>,
      width: "w-[150px]",
      align: "right",
      cell: (r) => (
        <Button size="sm" variant="outline" onClick={() => onDraft(r.merchantId)}>
          <Plus aria-hidden />
          Draft run
        </Button>
      ),
    },
  ];
  return (
    <Card
      title="Due for settlement"
      description={
        period.data
          ? `Period ${date(period.data.periodStart)} – ${date(period.data.periodEnd)} · pays ${date(period.data.payoutDate)}`
          : undefined
      }
      actions={
        <Button size="sm" variant="outline" onClick={() => onDraft("")}>
          <Plus aria-hidden />
          Draft for any merchant
        </Button>
      }
      bodyClassName="p-0"
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.merchantId}
        loading={due.isPending}
        error={due.isError ? "The due list could not be loaded." : null}
        emptyTitle="Nothing is due"
        emptyDescription="No banked COD is waiting for a settlement run."
        dense
      />
    </Card>
  );
}

// ─────────────────────────────────────────────────────────── new run

type DeductionDraft = { key: number; type: DeductionType; rupees: string; awb: string; description: string };

function NewSettlementDrawer({
  merchantId: initialMerchant,
  onClose,
  onCreated,
}: {
  merchantId: string | null;
  onClose: () => void;
  onCreated: (settlementId: string) => void;
}) {
  const open = initialMerchant !== null;
  const [merchantId, setMerchantId] = React.useState("");
  const [drafts, setDrafts] = React.useState<DeductionDraft[]>([]);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const nextKey = React.useRef(1);

  React.useEffect(() => {
    setMerchantId(initialMerchant ?? "");
    setDrafts([]);
    setConfirm(false);
    setError(null);
  }, [initialMerchant]);

  // Only complete rows are sent: a half-typed deduction must not make the
  // preview flicker into a 400.
  const parsed = drafts.map((d) => {
    const money = d.rupees.trim() ? rupeesToCents(d.rupees) : null;
    const cents = money && "cents" in money ? money.cents : null;
    const moneyError = money && "error" in money ? money.error : null;
    return { d, cents, moneyError, complete: cents !== null && cents > 0 && d.description.trim().length > 0 };
  });
  const deductions: Deduction[] = parsed
    .filter((p) => p.complete)
    .map((p) => ({
      type: p.d.type,
      amountCents: p.cents!,
      awb: p.d.awb.trim() || undefined,
      description: p.d.description.trim(),
    }));
  const debouncedDeductions = useDebounced(deductions, 400);
  const preview = useSettlementPreview(
    merchantId ? { merchantId, deductions: debouncedDeductions.length ? debouncedDeductions : undefined } : null,
  );
  const p = preview.data;
  const incomplete = parsed.some((x) => !x.complete);

  const create = useCreateSettlement({
    onSuccess: (r) => {
      setConfirm(false);
      onCreated(r.settlement.id);
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });

  const update = (key: number, patch: Partial<DeductionDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title="Draft a settlement run" subtitle="Preview first — nothing is booked until you create the draft.">
      <div className="space-y-5">
        <Field label="Merchant">
          <MerchantSelect value={merchantId} onChange={setMerchantId} codOnly />
        </Field>

        {merchantId ? (
          <>
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <SectionTitle>Manual deductions</SectionTitle>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDrafts((prev) => [...prev, { key: nextKey.current++, type: "adjustment", rupees: "", awb: "", description: "" }])
                  }
                >
                  <Plus aria-hidden />
                  Add deduction
                </Button>
              </div>
              {parsed.length === 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  COD fees and RTO charges are derived from the ledger. Add forwarding, weight discrepancies, penalties or adjustments here.
                </p>
              ) : null}
              {parsed.map(({ d, moneyError }, index) => (
                <div key={d.key} className="grid grid-cols-[1fr_120px_auto] gap-2 rounded-md border p-3">
                  <Field label="Type">
                    <Select value={d.type} onChange={(e) => update(d.key, { type: e.target.value as DeductionType })} aria-label={`Deduction ${index + 1} type`}>
                      {DEDUCTION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {humanise(t)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Rs." error={moneyError ?? undefined}>
                    <RupeeInput value={d.rupees} onChange={(v) => update(d.key, { rupees: v })} label={`Deduction ${index + 1} amount in rupees`} />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove deduction ${index + 1}`}
                      onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                  <Field label="AWB (optional)">
                    <Input value={d.awb} onChange={(e) => update(d.key, { awb: e.target.value })} className="font-mono" aria-label={`Deduction ${index + 1} AWB`} />
                  </Field>
                  <Field label="Description" className="col-span-2">
                    <Input value={d.description} onChange={(e) => update(d.key, { description: e.target.value })} aria-label={`Deduction ${index + 1} description`} placeholder="Re-weighed at hub: 2.4 kg declared 1 kg" />
                  </Field>
                </div>
              ))}
            </section>

            {preview.isError ? <ErrorNote>The preview could not be computed.</ErrorNote> : null}
            {p ? (
              <section className="space-y-3 border-t pt-4">
                <SectionTitle>
                  Preview · {date(p.period.periodStart)} – {date(p.period.periodEnd)}
                </SectionTitle>
                <div className="grid grid-cols-4 gap-3 rounded-md border p-3">
                  <Figure label="Gross" cents={p.grossCents} />
                  <Figure label="Deductions" cents={p.deductionsCents} />
                  <Figure label="Net" cents={p.netCents} />
                  <Figure label="Payable now" cents={p.payableCents} tone={p.payableCents < p.netCents ? "warn" : undefined} />
                </div>
                <p className="text-[12px] text-muted-foreground">{p.lines.length} line(s) in this run.</p>
                {p.heldParcels.length > 0 ? (
                  <div className="rounded-md border border-status-warn/40 bg-status-warn/5 p-3 text-[12px]">
                    <p className="font-medium">{p.heldParcels.length} parcel(s) held out of this run</p>
                    <ul className="mt-1 space-y-0.5">
                      {p.heldParcels.slice(0, 6).map((h) => (
                        <li key={h.parcelId} className="font-mono">
                          {h.awb ?? h.parcelId} · {money(h.amountCents)} · {h.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {p.blockingHolds.length > 0 ? (
                  <ErrorNote>
                    {p.blockingHolds.length} merchant-level hold(s) are open. The draft can be created, but it will be held until they are cleared.
                  </ErrorNote>
                ) : null}
                {/* The server repeats the hold warning in notes; the callout above already says it. */}
                <Notes notes={p.blockingHolds.length > 0 ? p.notes.filter((n) => !n.includes("merchant-level hold")) : p.notes} />
              </section>
            ) : preview.isFetching ? (
              <p className="text-[12px] text-muted-foreground">Computing preview…</p>
            ) : null}

            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="flex items-center gap-2 border-t pt-4">
              <Button disabled={!p || incomplete || p.lines.length === 0} onClick={() => setConfirm(true)}>
                <Wallet aria-hidden />
                Create draft
              </Button>
              {incomplete ? <p className="text-[12px] text-muted-foreground">Finish or remove the incomplete deduction first.</p> : null}
              {p && p.lines.length === 0 ? <p className="text-[12px] text-muted-foreground">There is nothing to settle for this merchant.</p> : null}
            </div>
          </>
        ) : null}

        <ConfirmDialog
          open={confirm}
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Create this settlement draft?"
          objectName={p?.merchantName ?? merchantId}
          destructive={false}
          confirmLabel={p ? `Draft ${money(p.netCents)}` : "Draft"}
          pending={create.isPending}
          body="The run is saved as a draft with these lines. No money moves until a second person approves it and a UTR is recorded."
          onConfirm={() => create.mutate({ merchantId, deductions: deductions.length ? deductions : undefined })}
        />
      </div>
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── one run

type Action = "propose" | "approve" | "reject" | "hold" | "release" | "pay";

function SettlementDrawer({
  settlementId,
  canWrite,
  onClose,
}: {
  settlementId: string | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const user = useUser();
  const detail = useSettlement(settlementId);
  const s = detail.data?.settlement;
  const [action, setAction] = React.useState<Action | null>(null);
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    setAction(null);
    setText("");
    setError(null);
    setDone(null);
  }, [settlementId]);

  const handlers = (verb: string) => ({
    onSuccess: (r: { code: string; status: string }) => {
      setAction(null);
      setText("");
      setError(null);
      setDone(`${r.code} ${verb}. Status is now ${humanise(r.status)}.`);
    },
    onError: (m: string) => {
      setAction(null);
      setDone(null);
      setError(m);
    },
  });
  const propose = useProposeSettlement(handlers("proposed"));
  const approve = useApproveSettlement(handlers("approved"));
  const reject = useRejectSettlement(handlers("rejected"));
  const hold = useHoldSettlement(handlers("put on hold"));
  const release = useReleaseSettlement(handlers("released back to draft"));
  const pay = useRecordPayout({
    onSuccess: (r) => {
      setAction(null);
      setText("");
      setError(null);
      setDone(`Paid. UTR ${r.settlement.utr} recorded and the ledger settled.`);
    },
    onError: (m) => {
      setAction(null);
      setDone(null);
      setError(m);
    },
  });

  const isMaker = s ? s.createdById === user.id : false;
  const needsText = action === "reject" || action === "hold" || action === "release" || action === "pay";
  const textOk = action === "pay" ? text.trim().length > 0 : text.trim().length >= 3;

  const run = () => {
    if (!s) return;
    const id = s.id;
    if (action === "propose") propose.mutate({ settlementId: id });
    else if (action === "approve") approve.mutate({ settlementId: id });
    else if (action === "reject") reject.mutate({ settlementId: id, reason: text.trim() });
    else if (action === "hold") hold.mutate({ settlementId: id, reason: text.trim() });
    else if (action === "release") release.mutate({ settlementId: id, note: text.trim() });
    else if (action === "pay") pay.mutate({ settlementId: id, utr: text.trim() });
  };
  const pending = propose.isPending || approve.isPending || reject.isPending || hold.isPending || release.isPending || pay.isPending;

  const can = (a: Action) => {
    if (!s || !canWrite) return false;
    switch (a) {
      case "propose":
        return s.status === "draft";
      case "approve":
        return s.status === "proposed";
      case "reject":
        return s.status !== "paid" && s.status !== "rejected";
      case "hold":
        return s.status === "draft" || s.status === "proposed" || s.status === "approved";
      case "release":
        return s.status === "on_hold";
      case "pay":
        return s.status === "approved";
    }
  };

  const COPY: Record<Action, { title: string; label: string; body: string; destructive: boolean; field?: string; placeholder?: string }> = {
    propose: { title: "Propose for approval?", label: "Propose", body: "The run goes to a checker. A different person from the one who drafted it must approve it.", destructive: false },
    approve: { title: "Approve this payout?", label: "Approve", body: `You are approving ${money(s?.netCents)} to ${s?.merchantName ?? "the merchant"}. Approval is final for this run; it can then be exported and paid.`, destructive: false },
    reject: { title: "Reject this run?", label: "Reject", body: "A rejected run is closed for good. Its parcels become due again and can go in a new run.", destructive: true, field: "Reason (required)", placeholder: "Deduction for AWB … is wrong; redraft" },
    hold: { title: "Put this run on hold?", label: "Hold", body: "The run cannot be approved or paid while held. Releasing it returns it to draft.", destructive: true, field: "Why is it held? (required)", placeholder: "Merchant disputes the RTO charges" },
    release: { title: "Release this hold?", label: "Release", body: "The run returns to draft and has to be proposed and approved again.", destructive: false, field: "Note (required)", placeholder: "Merchant confirmed the charges by email" },
    pay: { title: "Record the bank payment?", label: "Record payment", body: `Record that ${money(s?.netCents)} left the bank. The SETTLE, FEE and TAX entries are posted and the merchant's payable drops to match. This cannot be undone.`, destructive: false, field: "Bank UTR (required)", placeholder: "BOC2610010045123" },
  };

  return (
    <Drawer
      open={Boolean(settlementId)}
      onOpenChange={(next) => !next && onClose()}
      title={s?.code ?? "Settlement run"}
      subtitle={s ? `${s.merchantName} · ${date(s.periodStart)} – ${date(s.periodEnd)}` : undefined}
    >
      {detail.isError ? <ErrorNote>This settlement could not be loaded.</ErrorNote> : null}
      {s && detail.data ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s.status} />
            {detail.data.balanced ? <Badge variant="good">lines balance</Badge> : <Badge variant="bad">header ≠ lines</Badge>}
            {s.exportedAt ? <Badge variant="outline">payout file sent {date(s.exportedAt)}</Badge> : null}
          </div>
          <section className="grid grid-cols-3 gap-3 rounded-md border p-3">
            <Figure label="Gross" cents={s.grossCents} />
            <Figure label="Deductions" cents={s.deductionsCents} />
            <Figure label="Net payout" cents={s.netCents} />
          </section>
          <KeyValueGrid>
            <KeyValue label="Pays on">{date(s.payoutDate)}</KeyValue>
            <KeyValue label="Drafted by">{s.createdByName}</KeyValue>
            <KeyValue label="Proposed" mono>{s.proposedAt ? dateTime(s.proposedAt) : "—"}</KeyValue>
            <KeyValue label="Approved by">{s.approvedByName ?? "—"}</KeyValue>
            <KeyValue label="UTR" mono>{s.utr ?? "—"}</KeyValue>
            <KeyValue label="Paid" mono>{s.paidAt ? dateTime(s.paidAt) : "—"}</KeyValue>
            {s.holdReason ? <KeyValue label="Hold reason" className="col-span-2">{s.holdReason}</KeyValue> : null}
            {s.rejectedReason ? <KeyValue label="Rejected because" className="col-span-2">{s.rejectedReason}</KeyValue> : null}
          </KeyValueGrid>

          {s.status === "proposed" && canWrite ? (
            <p className={`rounded-md border px-3 py-2 text-[12px] ${isMaker ? "border-status-warn/40 bg-status-warn/5" : ""}`}>
              {isMaker
                ? `You drafted this run. Maker–checker (§8): someone other than ${s.createdByName} has to approve it.`
                : `Drafted by ${s.createdByName}. You are the checker.`}
            </p>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {canWrite ? (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {can("propose") ? (
                <Button size="sm" onClick={() => setAction("propose")}>
                  <Send aria-hidden />
                  Propose
                </Button>
              ) : null}
              {can("approve") ? (
                <Button size="sm" onClick={() => setAction("approve")}>
                  <CheckCheck aria-hidden />
                  Approve
                </Button>
              ) : null}
              {can("pay") ? (
                <Button size="sm" onClick={() => setAction("pay")}>
                  <Wallet aria-hidden />
                  Record payment (UTR)
                </Button>
              ) : null}
              {can("pay") ? <PayoutFileButton ids={[s.id]} /> : null}
              {can("release") ? (
                <Button size="sm" variant="outline" onClick={() => setAction("release")}>
                  <Undo2 aria-hidden />
                  Release hold
                </Button>
              ) : null}
              {can("hold") ? (
                <Button size="sm" variant="outline" onClick={() => setAction("hold")}>
                  <Hand aria-hidden />
                  Hold
                </Button>
              ) : null}
              {can("reject") ? (
                <Button size="sm" variant="destructive" onClick={() => setAction("reject")}>
                  <Ban aria-hidden />
                  Reject
                </Button>
              ) : null}
            </div>
          ) : null}

          <section className="space-y-2">
            <SectionTitle>Lines ({detail.data.lines.length})</SectionTitle>
            <div className="max-h-[340px] overflow-auto rounded-md border">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">Type</th>
                    <th className="px-3 py-1.5 font-medium">AWB</th>
                    <th className="px-3 py-1.5 font-medium">Description</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rs.</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.lines.map((l) => (
                    <tr key={l.id} className="border-t">
                      <td className="px-3 py-1.5">{humanise(l.type)}</td>
                      <td className="px-3 py-1.5 font-mono">{l.awb ?? "—"}</td>
                      <td className="px-3 py-1.5">{l.description}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${l.amountCents < 0 ? "text-status-bad" : ""}`}>{amount(l.amountCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {action ? (
            <ConfirmDialog
              open
              onOpenChange={(o) => !o && setAction(null)}
              title={COPY[action].title}
              objectName={s.code}
              destructive={COPY[action].destructive}
              confirmLabel={COPY[action].label}
              pending={pending}
              body={
                <div className="space-y-3">
                  <p>{COPY[action].body}</p>
                  {needsText ? (
                    <Field label={COPY[action].field ?? "Note"}>
                      {action === "pay" ? (
                        <Input value={text} onChange={(e) => setText(e.target.value)} className="font-mono" placeholder={COPY[action].placeholder} aria-label="Bank UTR" />
                      ) : (
                        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={COPY[action].placeholder} />
                      )}
                    </Field>
                  ) : null}
                </div>
              }
              confirmDisabled={needsText && !textOk}
              onConfirm={run}
            />
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── payout file

/**
 * Produces the bank upload file for approved runs. The server stamps them
 * exported; a second export of the same run comes back as a distinct
 * `already-exported` problem, and only then is "send it again" offered.
 */
function PayoutFileButton({ ids, onDone }: { ids: string[]; onDone?: () => void }) {
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [forceAsk, setForceAsk] = React.useState<string | null>(null);
  const [missingFor, setMissingFor] = React.useState<string | null>(null);
  const exporter = useExportPayoutCsv({
    onSuccess: (r) => {
      setForceAsk(null);
      setError(null);
      downloadText(`natex-payout-${colomboToday()}.csv`, r.csv);
      setDone(`${r.rows.length} payment(s), ${money(r.totalCents)}.`);
      onDone?.();
    },
    onError: (m, e) => {
      setDone(null);
      const details = apiDetails(e);
      setMissingFor(
        typeof details.type === "string" && details.type.endsWith("/payout-details-missing") && typeof details.merchantId === "string"
          ? details.merchantId
          : null,
      );
      if (details.forcable) {
        setForceAsk(m);
        setError(null);
      } else {
        setForceAsk(null);
        setError(m);
      }
    },
  });
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" variant="outline" disabled={ids.length === 0} pending={exporter.isPending && !forceAsk} onClick={() => exporter.mutate({ settlementIds: ids })}>
        <FileDown aria-hidden />
        Payout file{ids.length > 1 ? ` (${ids.length})` : ""}
      </Button>
      {error ? <span className="max-w-[320px] text-[11px] text-status-bad">{error}</span> : null}
      {error && missingFor ? (
        <Link href={`/finance/remittances?tab=bank&merchant=${encodeURIComponent(missingFor)}`} className="text-[11px] font-medium text-brand underline underline-offset-2">
          Add bank details
        </Link>
      ) : null}
      {done ? <output className="text-[11px] text-status-good">{done}</output> : null}
      <ConfirmDialog
        open={forceAsk !== null}
        onOpenChange={(o) => !o && setForceAsk(null)}
        title="Send this payout file again?"
        objectName={`${ids.length} run(s)`}
        confirmLabel="Export again"
        pending={exporter.isPending}
        body={`${forceAsk ?? ""} Uploading the same file twice pays the merchant twice.`}
        onConfirm={() => exporter.mutate({ settlementIds: ids, force: true })}
      />
    </span>
  );
}
