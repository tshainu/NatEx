import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { client, apiMessage } from "@/lib/api";
import { colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Page } from "@/components/natex/page";
import { useAuth } from "@/components/auth-provider";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";

type ReconInput = NonNullable<Parameters<typeof client.cod.reconciliationReport>[0]>;
type ReconResponse = Awaited<ReturnType<typeof client.cod.reconciliationReport>>;
type ReconRow = ReconResponse["rows"][number];
type RiderInput = NonNullable<Parameters<typeof client.cod.riderReport>[0]>;
type RiderResponse = Awaited<ReturnType<typeof client.cod.riderReport>>;
type RiderRow = RiderResponse["rows"][number];
type SettlementInput = NonNullable<Parameters<typeof client.cod.merchantSettlementReport>[0]>;
type SettlementResponse = Awaited<ReturnType<typeof client.cod.merchantSettlementReport>>;
type SettlementRow = SettlementResponse["rows"][number];

function daysBefore(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - days, 12)).toISOString().slice(0, 10);
}

function RiderTotals({ totals }: { totals: RiderResponse["totals"] }) {
  return <>
    <div className="grid min-w-[1600px] grid-cols-[1.2fr_0.9fr_repeat(9,1fr)] border-t-2 border-border bg-muted/60 px-4 py-3 text-right text-[13px] font-semibold"><span className="text-left">Totals</span><span className="font-mono tabular-nums">{(totals.deliveredWeightGrams / 1000).toFixed(2)} kg</span><span className="font-mono tabular-nums">{money(totals.deliveryChargeExpectedCents)}</span><span className="font-mono tabular-nums">{money(totals.counterPaidCents)}</span><span className="font-mono tabular-nums">{money(totals.expectedCents)}</span><span className="font-mono tabular-nums">{money(totals.collectedCents)}</span><span className="font-mono tabular-nums">{money(totals.totalExpectedCollectionCents)}</span><span className="font-mono tabular-nums">{money(totals.totalCollectedCollectionCents)}</span><span className="font-mono tabular-nums">{money(totals.balanceCents)}</span><span className="font-mono tabular-nums">{money(totals.deliveryChargeCollectedCents)}</span><span className="font-mono tabular-nums">{money(totals.totalOutstandingCents)}</span></div>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"><span className="font-medium">Total handover-able amount</span><span className="font-mono text-base font-semibold tabular-nums">{money(totals.totalOutstandingCents)}</span><span className="text-xs text-muted-foreground">COD balance + unpaid delivery charges</span></div>
  </>;
}

function RiderReportTab() {
  const today = colomboToday();
  const [page, setPage] = React.useState(1), [pageSize, setPageSize] = React.useState<Exclude<RiderInput["pageSize"], undefined>>(25);
  const [branchId, setBranchId] = React.useState(""), [riderId, setRiderId] = React.useState(""), [search, setSearch] = React.useState("");
  const [enteredFrom, setEnteredFrom] = React.useState(() => daysBefore(today, 29)), [enteredTo, setEnteredTo] = React.useState(today);
  React.useEffect(() => setPage(1), [branchId, riderId, search, enteredFrom, enteredTo, pageSize]);
  const request = { enteredFrom, enteredTo, branchId: branchId || undefined, riderId: riderId || undefined, search: search.trim() || undefined, page, pageSize } satisfies RiderInput;
  const invalid = enteredFrom.length === 10 && enteredTo.length === 10 && enteredFrom > enteredTo;
  const report = useQuery({ queryKey: ["cod", "riderReport", request], queryFn: () => client.cod.riderReport(request), enabled: enteredFrom.length === 10 && enteredTo.length === 10 && !invalid });
  const columns: Column<RiderRow>[] = [
    { key: "rider", header: "Rider", width: "w-[210px]", cell: (row) => <><span className="font-medium">{row.riderName}</span><br /><MonoCell>{row.branchName}</MonoCell></> },
    { key: "weight", header: "Delivered weight", align: "right", className: "font-mono tabular-nums", cell: (row) => `${(row.deliveredWeightGrams / 1000).toFixed(2)} kg` },
    { key: "weightCharge", header: "Weight-based delivery charge", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.deliveryChargeExpectedCents) },
    { key: "counterPaid", header: "Paid at counter", align: "right", className: "font-mono tabular-nums", cell: (row) => row.counterPaidCents > 0 ? <><span>{money(row.counterPaidCents)}</span><br /><span className="text-[11px] font-semibold text-status-ok">Paid</span></> : "—" },
    { key: "expected", header: "Expected COD", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.expectedCents) },
    { key: "collected", header: "Collected COD", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.collectedCents) },
    { key: "totalExpected", header: "Total to collect (COD + charge)", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.totalExpectedCollectionCents) },
    { key: "totalCollected", header: "Total collected", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.totalCollectedCollectionCents) },
    { key: "balance", header: "Balance", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.balanceCents) },
    { key: "charge", header: "Delivery charge collected", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.deliveryChargeCollectedCents) },
    { key: "outstanding", header: "Total outstanding", align: "right", className: "font-mono font-semibold tabular-nums", cell: (row) => money(row.totalOutstandingCents) },
  ];
  return <div className="space-y-3"><DataTable columns={columns} rows={report.data?.rows ?? []} rowKey={(row) => `${row.riderId}-${row.branchId}`} loading={report.isPending} error={report.isError ? apiMessage(report.error, "The rider report could not be loaded.") : invalid ? "Choose a start date on or before the end date." : null} emptyTitle="No rider totals match these filters" emptyDescription="Choose another hub, rider, search term, or date range." pagination={{ page: report.data?.page ?? page, pageSize: report.data?.pageSize ?? pageSize, total: report.data?.total ?? 0, onPageChange: setPage }} filters={<>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Hub / branch<Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All authorized hubs</option>{(report.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</Select></label>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Rider<Select value={riderId} onChange={(e) => setRiderId(e.target.value)}><option value="">All riders</option>{(report.data?.riders ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></label>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Search<Input value={search} placeholder="Rider name or ID" onChange={(e) => setSearch(e.target.value)} /></label>
    <label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">From<Input type="date" value={enteredFrom} max={enteredTo || undefined} onChange={(e) => setEnteredFrom(e.target.value)} /></label>
    <label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">Through<Input type="date" value={enteredTo} min={enteredFrom || undefined} max={today} onChange={(e) => setEnteredTo(e.target.value)} /></label>
    <label className="grid min-w-[105px] gap-1 text-[11px] font-medium text-muted-foreground">Rows<Select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value) as Exclude<RiderInput["pageSize"], undefined>)}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="0">All</option></Select></label>
  </>} />{report.data ? <RiderTotals totals={report.data.totals} /> : null}</div>;
}

function ReconciliationTab() {
  const today = colomboToday();
  const [page, setPage] = React.useState(1), [branchId, setBranchId] = React.useState("");
  const [enteredFrom, setEnteredFrom] = React.useState(() => daysBefore(today, 29)), [enteredTo, setEnteredTo] = React.useState(today);
  React.useEffect(() => setPage(1), [branchId, enteredFrom, enteredTo]);
  const request = { enteredFrom, enteredTo, branchId: branchId || undefined, page, pageSize: 25 } satisfies ReconInput;
  const invalid = enteredFrom.length === 10 && enteredTo.length === 10 && enteredFrom > enteredTo;
  const report = useQuery({ queryKey: ["cod", "reconciliationReport", request], queryFn: () => client.cod.reconciliationReport(request), enabled: enteredFrom.length === 10 && enteredTo.length === 10 && !invalid });
  const columns: Column<ReconRow>[] = [
    { key: "awb", header: "Tracking number", width: "w-[175px]", cell: (row) => <MonoCell>{row.awb}</MonoCell> }, { key: "branch", header: "Accountable branch / hub", width: "w-[220px]", cell: (row) => row.branchName }, { key: "booked", header: "Booked (Colombo)", cell: (row) => date(row.bookedAt) }, { key: "expected", header: "Expected COD", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.expectedCents) }, { key: "collected", header: "Collected COD", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.collectedCents) }, { key: "variance", header: "Collected − expected", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.varianceCents) }, { key: "at", header: "Collected (Colombo)", cell: (row) => row.collectedAt ? dateTime(row.collectedAt) : "—" }, { key: "result", header: "Reconciliation", cell: (row) => <span className={row.reconciliationStatus === "Mismatch" ? "font-semibold text-status-warn" : ""}>{row.reconciliationStatus}</span> }, { key: "status", header: "Parcel status", cell: (row) => humanise(row.status) },
  ];
  return <DataTable columns={columns} rows={report.data?.rows ?? []} rowKey={(row) => row.id} loading={report.isPending} error={report.isError ? apiMessage(report.error, "The COD reconciliation report could not be loaded.") : invalid ? "Choose a booking start date on or before the end date." : null} emptyTitle="No parcels with COD match these filters" emptyDescription="Widen the booking date range or choose another authorized branch." pagination={{ page: report.data?.page ?? page, pageSize: report.data?.pageSize ?? 25, total: report.data?.total ?? 0, onPageChange: setPage }} filters={<><label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Branch / hub<Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All authorized branches</option>{(report.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name} ({humanise(b.type)})</option>)}</Select></label><label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">Booked from<Input type="date" value={enteredFrom} max={enteredTo || undefined} onChange={(e) => setEnteredFrom(e.target.value)} /></label><label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">Booked through<Input type="date" value={enteredTo} min={enteredFrom || undefined} max={today} onChange={(e) => setEnteredTo(e.target.value)} /></label></>} />;
}


function MerchantSettlementTab() {
  const today = colomboToday();
  const [page, setPage] = React.useState(1), [pageSize, setPageSize] = React.useState<Exclude<SettlementInput["pageSize"], undefined>>(25);
  const [branchId, setBranchId] = React.useState(""), [riderId, setRiderId] = React.useState(""), [search, setSearch] = React.useState("");
  const [enteredFrom, setEnteredFrom] = React.useState(() => daysBefore(today, 29)), [enteredTo, setEnteredTo] = React.useState(today);
  React.useEffect(() => setPage(1), [branchId, riderId, search, enteredFrom, enteredTo, pageSize]);
  const request = { enteredFrom, enteredTo, branchId: branchId || undefined, riderId: riderId || undefined, search: search.trim() || undefined, page, pageSize } satisfies SettlementInput;
  const invalid = enteredFrom.length === 10 && enteredTo.length === 10 && enteredFrom > enteredTo;
  const report = useQuery({ queryKey: ["cod", "merchantSettlementReport", request], queryFn: () => client.cod.merchantSettlementReport(request), enabled: enteredFrom.length === 10 && enteredTo.length === 10 && !invalid });
  const columns: Column<SettlementRow>[] = [
    { key: "merchant", header: "Merchant", width: "w-[220px]", cell: (row) => <><span className="font-medium">{row.merchantName}</span><br /><MonoCell>{row.branchName}</MonoCell></> },
    { key: "gross", header: "Collected COD", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.grossCents) },
    { key: "deductions", header: "Deductions", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.deductionsCents) },
    { key: "settled", header: "Already settled", align: "right", className: "font-mono tabular-nums", cell: (row) => money(row.alreadySettledCents) },
    { key: "receivable", header: "Merchant receivable", align: "right", className: "font-mono font-semibold tabular-nums", cell: (row) => money(row.netReceivableCents) },
    { key: "status", header: "Settlement status", cell: (row) => humanise(row.status) },
  ];
  const totals = report.data?.totals;
  return <div className="space-y-3"><DataTable columns={columns} rows={report.data?.rows ?? []} rowKey={(row) => row.merchantId} loading={report.isPending} error={report.isError ? apiMessage(report.error, "The merchant settlement report could not be loaded.") : invalid ? "Choose a start date on or before the end date." : null} emptyTitle="No merchant receivables match these filters" emptyDescription="Choose another hub, rider, search term, or date range." pagination={{ page: report.data?.page ?? page, pageSize: report.data?.pageSize ?? pageSize, total: report.data?.total ?? 0, onPageChange: setPage }} filters={<>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Hub / branch<Select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All authorized hubs</option>{(report.data?.branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}</Select></label>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Rider ID<Select value={riderId} onChange={(e) => setRiderId(e.target.value)}><option value="">All riders</option>{(report.data?.riders ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></label>
    <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">Merchant search<Input value={search} placeholder="Merchant name or ID" onChange={(e) => setSearch(e.target.value)} /></label>
    <label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">From<Input type="date" value={enteredFrom} max={enteredTo || undefined} onChange={(e) => setEnteredFrom(e.target.value)} /></label>
    <label className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">Through<Input type="date" value={enteredTo} min={enteredFrom || undefined} max={today} onChange={(e) => setEnteredTo(e.target.value)} /></label>
    <label className="grid min-w-[105px] gap-1 text-[11px] font-medium text-muted-foreground">Rows<Select value={String(pageSize)} onChange={(e) => setPageSize(Number(e.target.value) as Exclude<SettlementInput["pageSize"], undefined>)}><option value="25">25</option><option value="50">50</option><option value="100">100</option><option value="500">500</option><option value="0">All</option></Select></label>
  </>} />{totals ? <div className="flex flex-wrap gap-5 rounded-lg border border-border bg-muted/60 px-4 py-3 text-sm"><span>Collected COD <b className="font-mono">{money(totals.grossCents)}</b></span><span>Deductions <b className="font-mono">{money(totals.deductionsCents)}</b></span><span>Already settled <b className="font-mono">{money(totals.alreadySettledCents)}</b></span><span>Receivable <b className="font-mono">{money(totals.netReceivableCents)}</b></span></div> : null}</div>;
}

export default function OpsCodReconciliation() {
  const { role } = useAuth();
  const [tab, setTab] = React.useState<"reconciliation" | "rider" | "settlement">(() => role === "hr" || role === "finance" || role === "rider" ? "rider" : "reconciliation");
  return <Page title="COD Reconciliation" description="Review parcel-level COD entries or aggregate rider cash and delivery-charge accountability."><div className="mb-4 flex gap-1 rounded-lg border border-border bg-muted/40 p-1" role="tablist"><button type="button" role="tab" aria-selected={tab === "reconciliation"} className={`rounded-md px-4 py-2 text-sm ${tab === "reconciliation" ? "bg-background font-semibold shadow-sm" : "text-muted-foreground"}`} onClick={() => setTab("reconciliation")}>COD Reconciliation</button><button type="button" role="tab" aria-selected={tab === "rider"} className={`rounded-md px-4 py-2 text-sm ${tab === "rider" ? "bg-background font-semibold shadow-sm" : "text-muted-foreground"}`} onClick={() => setTab("rider")}>Rider Report</button><button type="button" role="tab" aria-selected={tab === "settlement"} className={`rounded-md px-4 py-2 text-sm ${tab === "settlement" ? "bg-background font-semibold shadow-sm" : "text-muted-foreground"}`} onClick={() => setTab("settlement")}>Merchant Settlement Report</button></div>{tab === "rider" ? <RiderReportTab /> : tab === "settlement" ? <MerchantSettlementTab /> : <ReconciliationTab />}</Page>;
}
