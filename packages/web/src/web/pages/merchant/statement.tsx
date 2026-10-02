import * as React from "react";
import { Link } from "wouter";
import { Landmark } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
import { Card, ErrorNote, KeyValue, KeyValueGrid, Page } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { Drawer } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInvoicePage,
  useMerchantAr,
  useMerchantStatement,
  useSettlement,
  useSettlementPage,
  type FinanceIn,
  type FinanceOut,
} from "@/queries/finance";
import { EXPORT_PAGE, PAGE_SIZE, StatusBadge } from "../finance/shared";
import { maskAccount } from "../finance/bank-details";

/**
 * /merchant/statement — what NatEx owes this merchant and what it owes NatEx
 * (§8 settlement, §10 M4 invoicing). Every read is scoped to the signed-in
 * merchant by the server (§5); this page never names a merchant id.
 *
 * A merchant sees runs once finance has approved them (approved, on hold,
 * paid) and invoices once issued — drafts and proposals are the finance
 * desk's working state, not a promise.
 */

const TABS = ["summary", "settlements", "invoices"] as const;
type SettlementStatus = NonNullable<FinanceIn<"settlementPage">["status"]>[number];
type InvoiceStatus = NonNullable<FinanceIn<"invoicePage">["status"]>[number];
const VISIBLE_RUNS: SettlementStatus[] = ["approved", "on_hold", "paid"];
const VISIBLE_INVOICES: InvoiceStatus[] = ["issued", "part_paid", "paid"];

export default function MerchantStatement() {
  const [tab, setTab] = useTabParam("tab", TABS, "summary");
  return (
    <Page
      title="Statement"
      description="Your COD payable, settlement payouts and freight invoices. Figures are NatEx's ledger totals, to the cent."
    >
      <TabStrip
        label="Statement sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "summary", label: "Summary" },
          { id: "settlements", label: "Payouts" },
          { id: "invoices", label: "Invoices" },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "summary" ? <Summary /> : tab === "settlements" ? <Payouts /> : <Invoices />}
      </div>
    </Page>
  );
}

// ───────────────────────────────────────────────────────────────── summary

function Summary() {
  const statement = useMerchantStatement();
  const ar = useMerchantAr();
  const s = statement.data;
  const a = ar.data;
  const lastPaid = s?.settlements.find((r) => r.status === "paid") ?? null;

  if (statement.isError || ar.isError) return <ErrorNote>Your statement could not be loaded.</ErrorNote>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label="COD payable to you" value={s ? money(s.payableCents) : "—"} hint={s ? `${s.unsettledParcelCount} parcel(s) not yet settled` : undefined} />
        <MetricTile label="Last payout" value={lastPaid ? money(lastPaid.netCents) : "—"} hint={lastPaid ? `${lastPaid.code} · ${date(lastPaid.paidAt)}` : "No payout yet"} />
        <MetricTile label="Invoices outstanding" value={a ? money(a.outstandingCents) : "—"} hint={a ? `${a.invoices.filter((i) => i.outstandingCents > 0).length} invoice(s)` : undefined} />
        <MetricTile label="Payouts held" value={s ? s.openHolds.length : "—"} hint={s && s.openHolds.length ? "See below" : "Nothing held back"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Where we pay you" description="Bank details are changed only by NatEx finance, on a bank document.">
          {!s ? (
            <Skeleton className="h-20 w-full" />
          ) : s.payout ? (
            <KeyValueGrid>
              <KeyValue label="Beneficiary" className="col-span-2">{s.payout.beneficiaryName}</KeyValue>
              <KeyValue label="Bank">{s.payout.bankName}</KeyValue>
              <KeyValue label="Branch">{s.payout.branchName}</KeyValue>
              <KeyValue label="Account" mono>{maskAccount(s.payout.accountNumber)}</KeyValue>
              <KeyValue label="Verified">{s.payout.verified ? "Yes" : "Not yet"}</KeyValue>
            </KeyValueGrid>
          ) : (
            <div className="flex items-start gap-3">
              <Landmark aria-hidden className="mt-0.5 size-4 text-status-warn" />
              <p className="text-[13px]">
                No bank details on file, so payouts cannot be sent. Email a bank letter or a cancelled cheque to NatEx
                finance.
              </p>
            </div>
          )}
        </Card>

        <Card title="Held back from payouts" description="A hold keeps COD out of a payout until it is resolved.">
          {!s ? (
            <Skeleton className="h-20 w-full" />
          ) : s.openHolds.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Nothing is held back.</p>
          ) : (
            <ul className="divide-y divide-border">
              {s.openHolds.map((h) => (
                <li key={h.id} className="flex items-start justify-between gap-3 py-2 text-[13px]">
                  <span>
                    <span className="font-medium">{h.scope === "merchant" ? "All payouts" : (h.awb ?? "One parcel")}</span>
                    <span className="text-muted-foreground"> · {humanise(h.reason)}</span>
                    <span className="block text-[12px] text-muted-foreground">{h.detail}</span>
                  </span>
                  <span className="font-mono text-[12px]">{h.amountCents === null ? "—" : amount(h.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {s && s.openHolds.some((h) => h.reason === "dispute") ? (
            <p className="mt-3 text-[12px] text-muted-foreground">
              Dispute holds clear when the case is decided — <Link href="/merchant/disputes" className="text-brand underline underline-offset-2">see your disputes</Link>.
            </p>
          ) : null}
        </Card>
      </div>

      <Card title="Invoice ageing" description="Outstanding freight invoices by days past due.">
        {!a ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["0-30", "31-60", "61-90", "90+"] as const).map((b) => (
              <div key={b} className="rounded-md border border-border px-3 py-2">
                <div className="label-xs text-muted-foreground">{b} days</div>
                <div className="font-mono text-[15px]">{money(a.buckets[b] ?? 0)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── payouts

type Run = FinanceOut<"settlementPage">["rows"][number];

function Payouts() {
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const filter = { status: VISIBLE_RUNS };
  const list = useSettlementPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];

  const columns: Column<Run>[] = [
    { key: "code", header: "Payout", width: "w-[160px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "period", header: "Period", width: "w-[200px]", className: "text-[12px]", cell: (r) => `${date(r.periodStart)} – ${date(r.periodEnd)}` },
    { key: "gross", header: "COD", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.grossCents) },
    { key: "deductions", header: "Deductions", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.deductionsCents) },
    { key: "net", header: "Paid to you", align: "right", width: "w-[130px]", className: "font-mono text-[12px] font-semibold", cell: (r) => amount(r.netCents) },
    { key: "status", header: "Status", width: "w-[110px]", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "utr", header: "Bank ref (UTR)", cell: (r) => (r.utr ? <MonoCell>{r.utr}</MonoCell> : "—") },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Payouts could not be loaded." : null}
        emptyTitle="No payouts yet"
        emptyDescription="A payout appears here once NatEx finance approves it."
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <div className="ml-auto">
            <ExportCsvButton<Run>
              filename={`natex-payouts-${colomboToday()}.csv`}
              header={["payout", "period_start", "period_end", "payout_date", "cod_lkr", "deductions_lkr", "net_lkr", "status", "utr", "paid_at"]}
              toRow={(r) => [
                r.code,
                r.periodStart,
                r.periodEnd,
                r.payoutDate,
                centsToRupees(r.grossCents),
                centsToRupees(r.deductionsCents),
                centsToRupees(r.netCents),
                r.status,
                r.utr ?? "",
                r.paidAt ? dateTime(r.paidAt) : "",
              ]}
              fetchPage={(p) => client.finance.settlementPage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
            />
          </div>
        }
      />
      <PayoutDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function PayoutDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const detail = useSettlement(id);
  const d = detail.data;
  return (
    <Drawer
      open={id !== null}
      onOpenChange={(next) => !next && onClose()}
      title={d ? d.settlement.code : "Payout"}
      subtitle={d ? `${date(d.settlement.periodStart)} – ${date(d.settlement.periodEnd)}` : undefined}
    >
      {detail.isError ? (
        <ErrorNote>This payout could not be loaded.</ErrorNote>
      ) : !d ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <div className="space-y-5">
          <StatusBadge status={d.settlement.status} />
          <KeyValueGrid>
            <KeyValue label="COD collected" mono>{money(d.settlement.grossCents)}</KeyValue>
            <KeyValue label="Deductions" mono>{money(d.settlement.deductionsCents)}</KeyValue>
            <KeyValue label="Paid to you" mono>{money(d.settlement.netCents)}</KeyValue>
            <KeyValue label="Payout date" mono>{date(d.settlement.payoutDate)}</KeyValue>
            <KeyValue label="Bank ref (UTR)" mono>{d.settlement.utr ?? "—"}</KeyValue>
            <KeyValue label="Paid" mono>{d.settlement.paidAt ? dateTime(d.settlement.paidAt) : "—"}</KeyValue>
          </KeyValueGrid>
          <section className="space-y-2">
            <h3 className="label-xs text-muted-foreground">Lines ({d.lines.length})</h3>
            <ul className="divide-y divide-border rounded-md border border-border">
              {d.lines.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                  <span>
                    <span className="font-mono">{l.awb ?? humanise(l.type)}</span>
                    {l.description ? <span className="text-muted-foreground"> · {l.description}</span> : null}
                  </span>
                  <span className={`font-mono ${l.amountCents < 0 ? "text-status-bad" : ""}`}>{amount(l.amountCents)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}

// ──────────────────────────────────────────────────────────────── invoices

type Invoice = FinanceOut<"invoicePage">["rows"][number];

function Invoices() {
  const [page, setPage] = React.useState(1);
  const filter = { status: VISIBLE_INVOICES };
  const list = useInvoicePage(filter, page, PAGE_SIZE);
  const ar = useMerchantAr();
  const rows = list.data?.rows ?? [];
  const outstanding = (r: Invoice) => r.totalCents - r.paidCents - r.creditedCents - r.recoveredCents;

  const columns: Column<Invoice>[] = [
    { key: "code", header: "Invoice", width: "w-[160px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "period", header: "Period", width: "w-[200px]", className: "text-[12px]", cell: (r) => `${date(r.periodStart)} – ${date(r.periodEnd)}` },
    { key: "due", header: "Due", width: "w-[110px]", className: "text-[12px]", cell: (r) => date(r.dueDate) },
    { key: "total", header: "Total", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.totalCents) },
    { key: "settled", header: "Paid / credited", align: "right", width: "w-[140px]", className: "font-mono text-[12px]", cell: (r) => amount(r.paidCents + r.creditedCents + r.recoveredCents) },
    { key: "outstanding", header: "Outstanding", align: "right", width: "w-[130px]", className: "font-mono text-[12px] font-semibold", cell: (r) => amount(outstanding(r)) },
    { key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Invoices could not be loaded." : null}
        emptyTitle="No invoices yet"
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <div className="ml-auto">
            <ExportCsvButton<Invoice>
              filename={`natex-invoices-${colomboToday()}.csv`}
              header={["invoice", "period_start", "period_end", "due_date", "total_lkr", "paid_lkr", "credited_lkr", "recovered_from_cod_lkr", "outstanding_lkr", "status"]}
              toRow={(r) => [
                r.code,
                r.periodStart,
                r.periodEnd,
                r.dueDate,
                centsToRupees(r.totalCents),
                centsToRupees(r.paidCents),
                centsToRupees(r.creditedCents),
                centsToRupees(r.recoveredCents),
                centsToRupees(outstanding(r)),
                r.status,
              ]}
              fetchPage={(p) => client.finance.invoicePage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
            />
          </div>
        }
      />
      <Card title="Credit notes" description="Credits against your invoices, for example from an upheld dispute.">
        {!ar.data ? (
          <Skeleton className="h-12 w-full" />
        ) : ar.data.creditNotes.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No credit notes.</p>
        ) : (
          <ul className="divide-y divide-border">
            {ar.data.creditNotes.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-2 text-[13px]">
                <span>
                  <span className="font-mono">{c.code}</span>
                  <span className="text-muted-foreground"> · {c.reason} · {date(c.issuedAt)}</span>
                </span>
                <span className="font-mono text-[12px]">{amount(c.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
