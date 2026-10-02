import * as React from "react";
import { RotateCcw, Search, Undo2 } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
import { useDebounced } from "@/lib/hooks";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Card, ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { useEntries, useReconciliation, useReverseEntry, useStale, type CodOut } from "@/queries/cod";
import { EXPORT_PAGE, Figure, MerchantSelect, PAGE_SIZE, SectionTitle, useCanWriteMoney, useMerchantName } from "./shared";

/**
 * Ledger browser and four-way reconciliation (§8, §10 M4).
 *
 * The ledger is append-only: nothing on this screen edits a row. A correction
 * is a REVERSAL entry that references the original, posted by finance with a
 * reason, and both rows stay visible — the reversed one marked, never hidden.
 */

type Entry = CodOut<"entries">["rows"][number];

const ENTRY_TYPES = ["COLLECT", "DEPOSIT", "BANK", "ACCRUE", "SETTLE", "FEE", "TAX", "VARIANCE", "REVERSAL"] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

const TYPE_VARIANT: Record<string, "brand" | "warn" | "good" | "bad" | "muted" | "outline"> = {
  COLLECT: "warn",
  DEPOSIT: "brand",
  BANK: "good",
  ACCRUE: "outline",
  SETTLE: "good",
  FEE: "muted",
  TAX: "muted",
  VARIANCE: "bad",
  REVERSAL: "bad",
};

export function LedgerTab() {
  const canWrite = useCanWriteMoney();
  const merchantName = useMerchantName();
  const [type, setType] = React.useState<"" | EntryType>("");
  const [merchantId, setMerchantId] = React.useState("");
  const [awb, setAwb] = React.useState("");
  const [rider, setRider] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [open, setOpen] = React.useState<Entry | null>(null);

  const debouncedAwb = useDebounced(awb.trim().toUpperCase(), 250);
  const debouncedRider = useDebounced(rider.trim(), 250);
  React.useEffect(() => setPage(1), [type, merchantId, debouncedAwb, debouncedRider]);

  const filter = {
    type: type ? [type] : undefined,
    merchantId: merchantId || undefined,
    awb: debouncedAwb || undefined,
    riderId: debouncedRider || undefined,
  };
  const list = useEntries(filter, page, PAGE_SIZE);

  const columns: Column<Entry>[] = [
    { key: "seq", header: "#", width: "w-[70px]", className: "font-mono text-[12px] text-muted-foreground", cell: (r) => r.seq },
    { key: "ts", header: "Posted", width: "w-[150px]", className: "font-mono text-[12px]", cell: (r) => dateTime(r.ts) },
    {
      key: "type",
      header: "Type",
      width: "w-[110px]",
      cell: (r) => (
        <span className="flex items-center gap-1">
          <Badge variant={TYPE_VARIANT[r.type] ?? "muted"}>{r.type}</Badge>
          {r.reversedById ? <Badge variant="outline">reversed</Badge> : null}
        </span>
      ),
    },
    {
      key: "accounts",
      header: "Debit → credit",
      cell: (r) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {r.debitAccount} → {r.creditAccount}
        </span>
      ),
    },
    { key: "awb", header: "AWB", width: "w-[140px]", cell: (r) => (r.awb ? <MonoCell>{r.awb}</MonoCell> : <span className="text-muted-foreground">—</span>) },
    { key: "merchant", header: "Merchant", cell: (r) => <span className="truncate">{r.merchantId ? merchantName(r.merchantId) : "—"}</span> },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      width: "w-[130px]",
      className: `font-mono font-medium`,
      cell: (r) => <span className={r.reversedById ? "text-muted-foreground line-through" : ""}>{amount(r.amountCents)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The ledger could not be loaded." : null}
        emptyTitle="No entries match"
        emptyDescription="Nothing in the ledger matches these filters. The ledger only grows — clear a filter to see more."
        onRowClick={setOpen}
        dense
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Type" className="w-[150px]">
              <Select value={type} onChange={(e) => setType(e.target.value as "" | EntryType)} aria-label="Entry type">
                <option value="">All types</option>
                {ENTRY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Merchant" className="w-[220px]">
              <MerchantSelect value={merchantId} onChange={setMerchantId} allLabel="All merchants" />
            </Field>
            <Field label="AWB" className="w-[180px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={awb} onChange={(e) => setAwb(e.target.value)} placeholder="NX…" className="pl-8 font-mono" aria-label="Filter by AWB" />
              </div>
            </Field>
            <Field label="Rider id" className="w-[180px]">
              <Input value={rider} onChange={(e) => setRider(e.target.value)} placeholder="usr_…" className="font-mono" aria-label="Filter by rider id" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setType("");
                setMerchantId("");
                setAwb("");
                setRider("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto">
              <ExportCsvButton<Entry>
                filename={`natex-cod-ledger-${colomboToday()}.csv`}
                header={["seq", "posted", "type", "debit", "credit", "amount_lkr", "awb", "merchant_id", "rider_id", "deposit_id", "settlement_id", "reversal_of", "reversed_by", "actor", "note"]}
                toRow={(r) => [
                  r.seq,
                  dateTime(r.ts),
                  r.type,
                  r.debitAccount,
                  r.creditAccount,
                  centsToRupees(r.amountCents),
                  r.awb ?? "",
                  r.merchantId ?? "",
                  r.riderId ?? "",
                  r.depositId ?? "",
                  r.settlementId ?? "",
                  r.reversalOfId ?? "",
                  r.reversedById ?? "",
                  r.actorName ?? "",
                  r.note ?? "",
                ]}
                fetchPage={(p) =>
                  client.cod
                    .entries({ ...filter, limit: EXPORT_PAGE, offset: (p - 1) * EXPORT_PAGE })
                    .then((r) => ({ ...r, pageSize: EXPORT_PAGE }))
                }
              />
            </div>
          </>
        }
      />
      <EntryDrawer entry={open} canWrite={canWrite} merchantName={merchantName} onClose={() => setOpen(null)} />
    </div>
  );
}

function EntryDrawer({
  entry,
  canWrite,
  merchantName,
  onClose,
}: {
  entry: Entry | null;
  canWrite: boolean;
  merchantName: (id: string | null | undefined) => string;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setReason("");
    setConfirm(false);
    setError(null);
    setDone(null);
  }, [entry?.id]);

  const reverse = useReverseEntry({
    onSuccess: (r) => {
      setConfirm(false);
      setError(null);
      setDone(`Reversed by entry #${r.reversal.seq}. Both rows stay in the ledger.`);
    },
    onError: (m) => {
      setConfirm(false);
      setDone(null);
      setError(m);
    },
  });

  const reversible = entry && !entry.reversedById && !entry.reversalOfId && entry.type !== "REVERSAL" && !done;

  return (
    <Drawer
      open={Boolean(entry)}
      onOpenChange={(next) => !next && onClose()}
      title={entry ? `Entry #${entry.seq}` : "Entry"}
      subtitle={entry ? `${entry.type} · ${money(entry.amountCents)}` : undefined}
    >
      {entry ? (
        <div className="space-y-5">
          <KeyValueGrid>
            <KeyValue label="Posted" mono>{dateTime(entry.ts)}</KeyValue>
            <KeyValue label="Type">{entry.type}</KeyValue>
            <KeyValue label="Debit" mono>{entry.debitAccount}</KeyValue>
            <KeyValue label="Credit" mono>{entry.creditAccount}</KeyValue>
            <KeyValue label="Amount" mono>{money(entry.amountCents)}</KeyValue>
            <KeyValue label="Mode">{entry.mode ? humanise(entry.mode) : "—"}</KeyValue>
            <KeyValue label="AWB" mono>{entry.awb ?? "—"}</KeyValue>
            <KeyValue label="Merchant">{merchantName(entry.merchantId)}</KeyValue>
            <KeyValue label="Rider" mono>{entry.riderId ?? "—"}</KeyValue>
            <KeyValue label="Branch" mono>{entry.branchId ?? "—"}</KeyValue>
            <KeyValue label="Deposit" mono>{entry.depositId ?? "—"}</KeyValue>
            <KeyValue label="Settlement" mono>{entry.settlementId ?? "—"}</KeyValue>
            <KeyValue label="Reference" mono>{entry.ref ?? "—"}</KeyValue>
            <KeyValue label="Posted by">{entry.actorName ? `${entry.actorName} (${entry.actorRole ?? "system"})` : "System"}</KeyValue>
            {entry.reversalOfId ? <KeyValue label="Reverses" mono>{entry.reversalOfId}</KeyValue> : null}
            {entry.reversedById ? <KeyValue label="Reversed by" mono>{entry.reversedById}</KeyValue> : null}
          </KeyValueGrid>
          {entry.note ? <p className="rounded-md border p-3 text-[13px] text-muted-foreground">{entry.note}</p> : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {canWrite && reversible ? (
            <section className="space-y-2 border-t pt-4">
              <SectionTitle>Correct this entry</SectionTitle>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Entries are never edited (§8). Reversing posts an equal and opposite entry that references this one; both
                remain in the ledger and in every export.
              </p>
              <Field label="Reason" hint="Recorded on the reversal and in the audit log — at least 3 characters.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Collected against the wrong AWB at the door" />
              </Field>
              <Button size="sm" variant="destructive" disabled={reason.trim().length < 3} onClick={() => setConfirm(true)}>
                <Undo2 aria-hidden />
                Reverse entry
              </Button>
            </section>
          ) : null}

          <ConfirmDialog
            open={confirm}
            onOpenChange={(o) => !o && setConfirm(false)}
            title="Reverse this ledger entry?"
            objectName={`#${entry.seq} ${entry.type} ${money(entry.amountCents)}`}
            confirmLabel="Post reversal"
            pending={reverse.isPending}
            body="An opposite entry is posted with your reason. Balances that depended on this entry move back. This cannot be undone except by another correction."
            onConfirm={() => reverse.mutate({ entryId: entry.id, reason: reason.trim() })}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

export function ReconciliationTab() {
  const [merchantId, setMerchantId] = React.useState("");
  const recon = useReconciliation(merchantId ? { merchantId } : {});
  const stale = useStale();
  const r = recon.data;

  type Stale = CodOut<"stale">[number];
  const staleColumns: Column<Stale>[] = [
    { key: "awb", header: "AWB", width: "w-[150px]", cell: (s) => <MonoCell>{s.awb ?? "—"}</MonoCell> },
    { key: "rider", header: "Rider", cell: (s) => <span className="font-mono text-[12px]">{s.riderId ?? "—"}</span> },
    { key: "at", header: "Collected", width: "w-[160px]", className: "font-mono text-[12px]", cell: (s) => dateTime(s.collectedAt) },
    { key: "age", header: "Age", width: "w-[110px]", className: "font-mono text-[12px] text-status-bad", cell: (s) => `${s.ageHours} h` },
    { key: "amount", header: "Amount", align: "right", width: "w-[130px]", className: "font-mono font-medium", cell: (s) => amount(s.amountCents) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Scope" className="w-[260px]">
          <MerchantSelect value={merchantId} onChange={setMerchantId} allLabel="Whole network" />
        </Field>
        {r ? (
          <p className="pb-2 text-[12px] text-muted-foreground">
            {r.liveEntryCount} live entries · {r.reversedEntryCount} reversed ·{" "}
            {r.ledgerSumCents === 0 ? (
              <span className="text-status-good">ledger sums to zero</span>
            ) : (
              <span className="text-status-bad">ledger out by {money(r.ledgerSumCents)}</span>
            )}
          </p>
        ) : null}
      </div>
      {recon.isError ? <ErrorNote>The reconciliation could not be computed.</ErrorNote> : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Stage n={1} label="Collected" cents={r?.collectedCents} gapLabel="Still with riders" gap={r?.inRiderHandsCents} />
        <Stage n={2} label="Deposited" cents={r?.depositedCents} gapLabel="In branch safes" gap={r?.inBranchSafeCents} />
        <Stage n={3} label="Banked" cents={r?.bankedCents} gapLabel="Awaiting settlement" gap={r?.awaitingSettlementCents} />
        <Stage n={4} label="Settled" cents={r?.settledCents} gapLabel="Open cash variance" gap={r?.openVarianceCents} gapIsError />
      </div>

      <Card
        title="Stale collections"
        description="Cash collected and not deposited within the configured window (§8 control). Each one has an ops alert."
        bodyClassName="p-0"
      >
        <DataTable
          className="rounded-none border-0"
          columns={staleColumns}
          rows={stale.data ?? []}
          rowKey={(s) => s.entryId}
          loading={stale.isPending}
          error={stale.isError ? "Stale collections could not be loaded." : null}
          emptyTitle="Nothing is stale"
          emptyDescription="Every collection older than the window has been deposited."
        />
      </Card>
    </div>
  );
}

function Stage({
  n,
  label,
  cents,
  gap,
  gapLabel,
  gapIsError = false,
}: {
  n: number;
  label: string;
  cents: number | undefined;
  gap: number | undefined;
  gapLabel: string;
  gapIsError?: boolean;
}) {
  const flagged = gap !== undefined && gap !== 0 && gapIsError;
  return (
    <div className="space-y-2">
      <MetricTile label={`${n} · ${label}`} value={cents === undefined ? "—" : money(cents)} />
      <div className={`rounded-md border px-3 py-2 ${flagged ? "border-status-bad/40 bg-status-bad/8" : ""}`}>
        <Figure label={gapLabel} cents={gap} tone={flagged ? "bad" : undefined} />
      </div>
    </div>
  );
}

