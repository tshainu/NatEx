import * as React from "react";
import { BellOff, CheckCircle2, Pencil, Play, RotateCcw } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, dateTime, humanise, money, since } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
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
  useAcknowledgeAlert,
  useAlertCounts,
  useAlertPage,
  useFinanceConfig,
  useInvariantRuns,
  useResolveAlert,
  useRunInvariant,
  useSetConfig,
  type CodIn,
  type CodOut,
} from "@/queries/cod";
import { EXPORT_PAGE, PAGE_SIZE, SectionTitle, StatusBadge, useCanWriteMoney } from "./shared";

/**
 * The COD controls (§8 "Controls"): the nightly balance invariant, the alert
 * desk, and the finance configuration every rule above reads from.
 */

// ─────────────────────────────────────────────────────────── invariant

type Run = CodOut<"invariantRuns">[number];
type Breach = { riderId?: string; riderName?: string | null; liabilityCents?: number; accountBalanceCents?: number; differenceCents?: number };

function breachesOf(run: Run): Breach[] {
  try {
    const parsed = JSON.parse(run.detailsJson ?? "null") as unknown;
    if (Array.isArray(parsed)) return parsed as Breach[];
    const inner = (parsed as { breaches?: unknown } | null)?.breaches;
    return Array.isArray(inner) ? (inner as Breach[]) : [];
  } catch {
    return [];
  }
}

export function InvariantTab() {
  const canWrite = useCanWriteMoney();
  const runs = useInvariantRuns(60);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const runNow = useRunInvariant({
    onSuccess: (r) => {
      setConfirm(false);
      setError(null);
      setDone(
        r.result === "ok"
          ? `Invariant holds for ${r.ridersChecked} rider(s). Ledger sum ${money(r.ledgerSumCents)}.`
          : `Breached: ${r.breaches.length} rider(s) do not reconcile. An alert has been raised.`,
      );
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });
  const rows = runs.data ?? [];
  const latest = rows[0];
  const opened = rows.find((r) => r.id === openId) ?? null;

  const columns: Column<Run>[] = [
    { key: "date", header: "Run date", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => r.runDate },
    { key: "at", header: "Ran at", width: "w-[170px]", className: "font-mono text-[12px]", cell: (r) => dateTime(r.ranAt) },
    { key: "trigger", header: "Trigger", width: "w-[110px]", cell: (r) => <Badge variant={r.trigger === "manual" ? "outline" : "muted"}>{r.trigger}</Badge> },
    { key: "result", header: "Result", width: "w-[110px]", cell: (r) => <StatusBadge status={r.result} /> },
    { key: "riders", header: "Riders", align: "right", width: "w-[90px]", className: "font-mono text-[12px]", cell: (r) => r.ridersChecked },
    { key: "breaches", header: "Breaches", align: "right", width: "w-[100px]", className: "font-mono text-[12px]", cell: (r) => <span className={r.breachCount ? "text-status-bad" : ""}>{r.breachCount}</span> },
    { key: "liab", header: "Rider liability", align: "right", width: "w-[150px]", className: "font-mono text-[12px]", cell: (r) => amount(r.riderLiabilityCents) },
    { key: "sum", header: "Ledger Σ", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => <span className={r.ledgerSumCents !== 0 ? "text-status-bad" : ""}>{amount(r.ledgerSumCents)}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Last result" value={latest ? humanise(latest.result) : "—"} hint={latest ? since(latest.ranAt) : "Never run"} accent={latest?.result === "breached" ? "var(--status-bad)" : undefined} />
        <MetricTile label="Riders checked" value={latest ? latest.ridersChecked : "—"} />
        <MetricTile label="Breaches (last 60 runs)" value={runs.data ? rows.filter((r) => r.result === "breached").length : "—"} />
        <MetricTile label="Ledger Σ (last run)" value={latest ? money(latest.ledgerSumCents) : "—"} hint="Double entry: must be Rs. 0.00" />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {done ? <SuccessNote>{done}</SuccessNote> : null}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={runs.isPending}
        error={runs.isError ? "Invariant runs could not be loaded." : null}
        emptyTitle="The invariant has not run yet"
        emptyDescription="It runs nightly; run it now to get a first reading."
        onRowClick={(r) => setOpenId(r.id)}
        rowClassName={(r) => (r.result === "breached" ? "bg-status-bad/5" : undefined)}
        filters={
          <>
            <p className="text-[12px] text-muted-foreground">Σ collected − Σ deposited per rider must equal the rider_cash account. Runs nightly.</p>
            <div className="ml-auto flex items-center gap-2">
              {canWrite ? (
                <Button size="sm" onClick={() => setConfirm(true)}>
                  <Play aria-hidden />
                  Run now
                </Button>
              ) : null}
              <ExportCsvButton<Run>
                filename={`natex-invariant-runs-${colomboToday()}.csv`}
                header={["run_date", "ran_at", "trigger", "result", "riders_checked", "breach_count", "rider_liability_lkr", "ledger_sum_lkr"]}
                toRow={(r) => [r.runDate, dateTime(r.ranAt), r.trigger, r.result, r.ridersChecked, r.breachCount, centsToRupees(r.riderLiabilityCents), centsToRupees(r.ledgerSumCents)]}
                fetchPage={async () => ({ rows, total: rows.length, pageSize: Math.max(1, rows.length) })}
              />
            </div>
          </>
        }
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={(o) => !o && setConfirm(false)}
        title="Run the invariant check now?"
        objectName="every rider"
        destructive={false}
        confirmLabel="Run check"
        pending={runNow.isPending}
        body="Reads the whole ledger and compares each rider's collections and deposits to their cash account. A breach raises a high-severity alert. Nothing is changed."
        onConfirm={() => runNow.mutate({})}
      />
      <Drawer open={Boolean(opened)} onOpenChange={(o) => !o && setOpenId(null)} title={opened ? `Invariant run ${opened.runDate}` : "Run"} subtitle={opened ? `${opened.trigger} · ${dateTime(opened.ranAt)}` : undefined}>
        {opened ? (
          <div className="space-y-4">
            <StatusBadge status={opened.result} />
            <KeyValueGrid>
              <KeyValue label="Riders checked" mono>{opened.ridersChecked}</KeyValue>
              <KeyValue label="Breaches" mono>{opened.breachCount}</KeyValue>
              <KeyValue label="Rider liability" mono>{money(opened.riderLiabilityCents)}</KeyValue>
              <KeyValue label="Ledger Σ" mono>{money(opened.ledgerSumCents)}</KeyValue>
            </KeyValueGrid>
            {breachesOf(opened).length > 0 ? (
              <section className="space-y-2">
                <SectionTitle>Riders that do not reconcile</SectionTitle>
                <ul className="space-y-1 text-[12px]">
                  {breachesOf(opened).map((b, i) => (
                    <li key={b.riderId ?? i} className="rounded-md border px-3 py-1.5">
                      <span className="font-mono">{b.riderId ?? "?"}</span>
                      {b.riderName ? ` · ${b.riderName}` : ""}
                      {b.liabilityCents !== undefined ? ` · liability ${money(b.liabilityCents)}` : ""}
                      {b.accountBalanceCents !== undefined ? ` · account ${money(b.accountBalanceCents)}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="space-y-2">
              <SectionTitle>Raw details</SectionTitle>
              <pre className="max-h-[300px] overflow-auto rounded-md border bg-muted p-3 text-[11px]">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(opened.detailsJson ?? "null"), null, 2);
                  } catch {
                    return opened.detailsJson ?? "";
                  }
                })()}
              </pre>
            </section>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────── alerts

type Alert = CodOut<"alertPage">["rows"][number];
type AlertFilterIn = NonNullable<CodIn<"alertPage">>;
type AlertStatus = NonNullable<AlertFilterIn["status"]>[number];
type AlertKind = NonNullable<AlertFilterIn["kind"]>;

const KINDS: AlertKind[] = [
  "amount_mismatch",
  "ceiling_breached",
  "deposit_variance",
  "stale_collection",
  "invariant_breached",
  "settlement_approved",
  "settlement_paid",
  "dispute_opened",
];
const SEVERITY: Record<string, "bad" | "warn" | "muted"> = { high: "bad", medium: "warn", low: "muted" };

export function AlertsTab() {
  const counts = useAlertCounts();
  const [status, setStatus] = React.useState<"" | AlertStatus | "live">("live");
  const [kind, setKind] = React.useState<"" | AlertKind>("");
  const [audience, setAudience] = React.useState<"" | "ops" | "finance">("");
  const [actionOnly, setActionOnly] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  React.useEffect(() => setPage(1), [status, kind, audience, actionOnly]);

  const filter: Omit<AlertFilterIn, "page" | "pageSize"> = {
    status: status === "live" ? ["open", "acknowledged"] : status ? [status] : undefined,
    kind: kind || undefined,
    audience: audience || undefined,
    actionRequiredOnly: actionOnly,
  };
  const list = useAlertPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];
  const opened = rows.find((r) => r.id === openId) ?? null;

  const columns: Column<Alert>[] = [
    { key: "at", header: "Raised", width: "w-[120px]", className: "text-[12px]", cell: (r) => since(r.createdAt) },
    { key: "sev", header: "Severity", width: "w-[90px]", cell: (r) => <Badge variant={SEVERITY[r.severity] ?? "muted"}>{r.severity}</Badge> },
    { key: "kind", header: "Kind", width: "w-[160px]", cell: (r) => humanise(r.kind) },
    { key: "summary", header: "Summary", cell: (r) => <span className="line-clamp-1 text-[12px]">{r.summary}</span> },
    { key: "who", header: "For", width: "w-[80px]", className: "text-[12px]", cell: (r) => r.audience },
    { key: "amount", header: "Amount", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => (r.amountCents === null ? "—" : amount(r.amountCents)) },
    { key: "status", header: "Status", width: "w-[120px]", cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Open" value={counts.data?.open ?? "—"} accent={counts.data?.open ? "var(--status-warn)" : undefined} />
        <MetricTile label="High severity open" value={counts.data?.highOpen ?? "—"} accent={counts.data?.highOpen ? "var(--status-bad)" : undefined} />
        <MetricTile label="Acknowledged" value={counts.data?.acknowledged ?? "—"} hint="Someone is on it" />
        <MetricTile label="Kinds open" value={counts.data ? Object.keys(counts.data.byKind).length : "—"} />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Alerts could not be loaded." : null}
        emptyTitle="No alerts match"
        emptyDescription={status === "live" ? "Nothing needs attention." : undefined}
        onRowClick={(r) => setOpenId(r.id)}
        rowClassName={(r) => (r.severity === "high" && r.status === "open" ? "bg-status-bad/5" : undefined)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[200px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Alert status">
                <option value="live">Live (open + acknowledged)</option>
                <option value="open">Open</option>
                <option value="acknowledged">Acknowledged</option>
                <option value="resolved">Resolved</option>
                <option value="">All</option>
              </Select>
            </Field>
            <Field label="Kind" className="w-[190px]">
              <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Alert kind">
                <option value="">Any kind</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {humanise(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Desk" className="w-[130px]">
              <Select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} aria-label="Alert desk">
                <option value="">Both</option>
                <option value="finance">Finance</option>
                <option value="ops">Ops</option>
              </Select>
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
              <input type="checkbox" aria-label="Action required only" checked={actionOnly} onChange={(e) => setActionOnly(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
              Action required only
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("live");
                setKind("");
                setAudience("");
                setActionOnly(true);
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto">
              <ExportCsvButton<Alert>
                filename={`natex-alerts-${colomboToday()}.csv`}
                header={["id", "raised_at", "severity", "kind", "audience", "status", "action_required", "summary", "awb", "rider_id", "merchant_id", "amount_lkr", "acknowledged_by", "resolved_by", "resolution_note"]}
                toRow={(r) => [
                  r.id,
                  dateTime(r.createdAt),
                  r.severity,
                  r.kind,
                  r.audience,
                  r.status,
                  r.actionRequired ? "yes" : "no",
                  r.summary,
                  r.awb ?? "",
                  r.riderId ?? "",
                  r.merchantId ?? "",
                  r.amountCents === null ? "" : centsToRupees(r.amountCents),
                  r.acknowledgedByName ?? "",
                  r.resolvedByName ?? "",
                  r.resolutionNote ?? "",
                ]}
                fetchPage={(p) => client.cod.alertPage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
              />
            </div>
          </>
        }
      />
      <AlertDrawer alert={opened} onClose={() => setOpenId(null)} />
    </div>
  );
}

function AlertDrawer({ alert, onClose }: { alert: Alert | null; onClose: () => void }) {
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setNote("");
    setConfirm(false);
    setError(null);
    setDone(null);
  }, [alert?.id]);
  const fail = (m: string) => {
    setConfirm(false);
    setDone(null);
    setError(m);
  };
  const ack = useAcknowledgeAlert({ onSuccess: () => { setError(null); setDone("Acknowledged — you own it now."); }, onError: fail });
  const resolve = useResolveAlert({ onSuccess: () => { setConfirm(false); setError(null); setDone("Resolved."); }, onError: fail });

  return (
    <Drawer open={Boolean(alert)} onOpenChange={(o) => !o && onClose()} title={alert ? humanise(alert.kind) : "Alert"} subtitle={alert ? `${alert.severity} · ${alert.audience} desk · ${dateTime(alert.createdAt)}` : undefined}>
      {alert ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={alert.status} />
            <Badge variant={SEVERITY[alert.severity] ?? "muted"}>{alert.severity}</Badge>
            {alert.actionRequired ? null : <Badge variant="outline">for information</Badge>}
          </div>
          <p className="text-[13px]">{alert.summary}</p>
          <KeyValueGrid>
            {alert.awb ? <KeyValue label="AWB" mono>{alert.awb}</KeyValue> : null}
            {alert.riderId ? <KeyValue label="Rider" mono>{alert.riderId}</KeyValue> : null}
            {alert.merchantId ? <KeyValue label="Merchant" mono>{alert.merchantId}</KeyValue> : null}
            {alert.amountCents !== null ? <KeyValue label="Amount" mono>{money(alert.amountCents)}</KeyValue> : null}
            {alert.depositId ? <KeyValue label="Deposit" mono>{alert.depositId}</KeyValue> : null}
            {alert.settlementId ? <KeyValue label="Settlement" mono>{alert.settlementId}</KeyValue> : null}
            {alert.disputeId ? <KeyValue label="Dispute" mono>{alert.disputeId}</KeyValue> : null}
            <KeyValue label="Acknowledged by">{alert.acknowledgedByName ?? "—"}</KeyValue>
            <KeyValue label="Resolved by">{alert.resolvedByName ?? "—"}</KeyValue>
            {alert.resolutionNote ? <KeyValue label="Resolution" className="col-span-2">{alert.resolutionNote}</KeyValue> : null}
          </KeyValueGrid>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}
          {alert.status !== "resolved" ? (
            <section className="space-y-3 border-t pt-4">
              {alert.status === "open" ? (
                <Button size="sm" variant="outline" pending={ack.isPending} onClick={() => ack.mutate({ alertId: alert.id })}>
                  <BellOff aria-hidden />
                  Acknowledge
                </Button>
              ) : null}
              <Field label="Resolution note (at least 3 characters)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Rider deposited the balance; deposit DEP… banked" />
              </Field>
              <Button size="sm" disabled={note.trim().length < 3} onClick={() => setConfirm(true)}>
                <CheckCircle2 aria-hidden />
                Resolve
              </Button>
            </section>
          ) : null}
          <ConfirmDialog
            open={confirm}
            onOpenChange={(o) => !o && setConfirm(false)}
            title="Resolve this alert?"
            objectName={alert.awb ?? alert.riderId ?? alert.id}
            destructive={false}
            confirmLabel="Resolve"
            pending={resolve.isPending}
            body="The alert leaves the desk. Resolving it does not change any money — make sure the underlying cause is dealt with."
            onConfirm={() => resolve.mutate({ alertId: alert.id, note: note.trim() })}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── config

type ConfigRow = CodOut<"listConfig">[number];

function shown(row: ConfigRow): string {
  if (row.unit === "cents") return money(row.value);
  if (row.unit === "basis_points") return `${(row.value / 100).toFixed(2)}%`;
  if (row.unit === "boolean") return row.value ? "On" : "Off";
  return `${row.value}${row.unit ? ` ${row.unit}` : ""}`;
}

export function ConfigTab() {
  const canWrite = useCanWriteMoney();
  const config = useFinanceConfig();
  const [editing, setEditing] = React.useState<ConfigRow | null>(null);
  const rows = config.data ?? [];
  const columns: Column<ConfigRow>[] = [
    { key: "key", header: "Setting", width: "w-[260px]", cell: (r) => <MonoCell>{r.key}</MonoCell> },
    { key: "desc", header: "What it controls", cell: (r) => <span className="text-[12px]">{r.description}</span> },
    { key: "value", header: "Value", align: "right", width: "w-[140px]", className: "font-mono", cell: (r) => shown(r) },
    { key: "raw", header: "Raw", align: "right", width: "w-[110px]", className: "font-mono text-[11px] text-muted-foreground", cell: (r) => `${r.value}${r.unit ? ` ${r.unit}` : ""}` },
    { key: "by", header: "Last changed", width: "w-[180px]", className: "text-[12px]", cell: (r) => (r.updatedAt ? `${r.updatedByName ?? "system"} · ${since(r.updatedAt)}` : "Default") },
    ...(canWrite
      ? [
          {
            key: "edit",
            header: <span className="sr-only">Edit</span>,
            width: "w-[60px]",
            cell: (r: ConfigRow) => (
              <Button size="icon-sm" variant="ghost" aria-label={`Change ${r.key}`} onClick={() => setEditing(r)}>
                <Pencil aria-hidden />
              </Button>
            ),
          } satisfies Column<ConfigRow>,
        ]
      : []),
  ];
  return (
    <div className="space-y-4">
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} loading={config.isPending} error={config.isError ? "Finance settings could not be loaded." : null} emptyTitle="No settings" />
      <ConfigDrawer row={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function ConfigDrawer({ row, onClose }: { row: ConfigRow | null; onClose: () => void }) {
  const [value, setValue] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setValue(row ? String(row.value) : "");
    setReason("");
    setConfirm(false);
    setError(null);
    setDone(null);
  }, [row]);
  const save = useSetConfig({
    onSuccess: (r) => {
      setConfirm(false);
      setError(null);
      setDone(`${r.key}: ${r.before} → ${r.after}. Every new calculation uses it from now.`);
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });
  const parsed = Number(value);
  const valueOk = value.trim() !== "" && Number.isInteger(parsed);
  const changed = row ? parsed !== row.value : false;

  return (
    <Drawer open={Boolean(row)} onOpenChange={(o) => !o && onClose()} title={row?.key ?? "Setting"} subtitle={row?.description}>
      {row ? (
        <div className="space-y-4">
          <KeyValueGrid>
            <KeyValue label="Current" mono>{shown(row)}</KeyValue>
            <KeyValue label="Unit" mono>{row.unit ?? "—"}</KeyValue>
            {row.note ? <KeyValue label="Note" className="col-span-2">{row.note}</KeyValue> : null}
          </KeyValueGrid>
          <Field label={`New value (whole number${row.unit ? `, in ${row.unit}` : ""})`} error={value.trim() && !valueOk ? "A whole number." : undefined}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric" className="font-mono" aria-label="New value" />
          </Field>
          <Field label="Reason (at least 5 characters, kept in the audit log)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}
          <Button disabled={!valueOk || !changed || reason.trim().length < 5} onClick={() => setConfirm(true)}>
            Save
          </Button>
          <ConfirmDialog
            open={confirm}
            onOpenChange={(o) => !o && setConfirm(false)}
            title="Change this setting?"
            objectName={row.key}
            destructive={false}
            confirmLabel={`Set to ${value}`}
            pending={save.isPending}
            body="Money rules read this value on the next calculation. Runs and invoices already drafted keep the figures they were built with."
            onConfirm={() => save.mutate({ key: row.key, value: parsed, reason: reason.trim() })}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
