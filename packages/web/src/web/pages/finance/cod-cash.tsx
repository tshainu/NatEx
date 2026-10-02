import * as React from "react";
import { Landmark, RotateCcw, Scale } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, date, dateTime, money, since } from "@/lib/format";
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
  useBankDeposit,
  useDepositPage,
  useRiderCashBoard,
  useVerifyDeposit,
  type CodOut,
} from "@/queries/cod";
import { EXPORT_PAGE, Figure, PAGE_SIZE, RupeeInput, SectionTitle, StatusBadge, useCanWriteMoney, useRupees } from "./shared";

/**
 * Rider cash and the deposit desk (§8 checkpoints 1→3).
 *
 * Rider cash is the balance invariant made visible: Σ collected − Σ deposited
 * per rider, beside the rider_cash account it must equal. A rider over the
 * ceiling is blocked from dispatch by the server; this board says who and by
 * how much.
 *
 * A deposit moves declared → verified (the cashier's count) → banked (the bank
 * slip). A count that differs from what the parcels said must carry a reason;
 * the server refuses it otherwise and the refusal is shown as written.
 */

type RiderCash = CodOut<"riderCashBoard">[number];
type Deposit = CodOut<"depositPage">["rows"][number];
type DepositStatus = "declared" | "verified" | "banked" | "rejected";

export function RiderCashTab() {
  const board = useRiderCashBoard();
  const rows = board.data ?? [];
  const holding = rows.filter((r) => r.liabilityCents !== 0);
  const total = holding.reduce((s, r) => s + r.liabilityCents, 0);
  const over = rows.filter((r) => r.overCeiling);
  const mismatched = rows.filter((r) => r.liabilityCents !== r.accountBalanceCents);
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? rows : holding;

  const columns: Column<RiderCash>[] = [
    {
      key: "rider",
      header: "Rider",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{r.riderName ?? "Unknown rider"}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{r.riderId}</p>
        </div>
      ),
    },
    { key: "branch", header: "Branch", width: "w-[150px]", className: "font-mono text-[12px]", cell: (r) => r.branchId ?? "—" },
    { key: "last", header: "Last collection", width: "w-[150px]", className: "text-[12px]", cell: (r) => (r.lastCollectAt ? since(r.lastCollectAt) : "—") },
    { key: "collected", header: "Collected", align: "right", width: "w-[130px]", className: "font-mono text-[12px]", cell: (r) => amount(r.collectedCents) },
    { key: "deposited", header: "Deposited", align: "right", width: "w-[130px]", className: "font-mono text-[12px]", cell: (r) => amount(r.depositedCents) },
    {
      key: "holding",
      header: "Holding now",
      align: "right",
      width: "w-[150px]",
      className: "font-mono font-medium",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.overCeiling ? <Badge variant="bad">over ceiling</Badge> : null}
          {r.liabilityCents !== r.accountBalanceCents ? <Badge variant="bad">invariant</Badge> : null}
          {amount(r.liabilityCents)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Cash with riders" value={board.data ? money(total) : "—"} hint={`${holding.length} rider(s) holding cash`} />
        <MetricTile label="Over the ceiling" value={board.data ? over.length : "—"} hint={rows[0] ? `Ceiling ${money(rows[0].ceilingCents)}` : undefined} accent={over.length ? "var(--status-bad)" : undefined} />
        <MetricTile label="Invariant mismatches" value={board.data ? mismatched.length : "—"} hint="Σ collected − Σ deposited ≠ rider_cash" accent={mismatched.length ? "var(--status-bad)" : undefined} />
        <MetricTile label="Riders in ledger" value={board.data ? rows.length : "—"} />
      </div>
      <DataTable
        columns={columns}
        rows={shown}
        rowKey={(r) => r.riderId}
        loading={board.isPending}
        error={board.isError ? "Rider cash could not be loaded." : null}
        emptyTitle={showAll ? "No rider has touched COD yet" : "No rider is holding cash"}
        emptyDescription={showAll ? undefined : "Every collection has been deposited. Show all riders to see the history."}
        rowClassName={(r) => (r.overCeiling ? "bg-status-bad/5" : undefined)}
        filters={
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                aria-label="Show riders holding no cash"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="size-4 accent-[var(--color-brand)]"
              />
              Show riders holding no cash
            </label>
            <div className="ml-auto">
              <ExportCsvButton<RiderCash>
                filename={`natex-rider-cash-${colomboToday()}.csv`}
                header={["rider_id", "rider", "branch", "collected_lkr", "deposited_lkr", "holding_lkr", "rider_cash_account_lkr", "over_ceiling", "last_collection"]}
                toRow={(r) => [
                  r.riderId,
                  r.riderName ?? "",
                  r.branchId ?? "",
                  centsToRupees(r.collectedCents),
                  centsToRupees(r.depositedCents),
                  centsToRupees(r.liabilityCents),
                  centsToRupees(r.accountBalanceCents),
                  r.overCeiling ? "yes" : "no",
                  r.lastCollectAt ? dateTime(r.lastCollectAt) : "",
                ]}
                fetchPage={async () => ({ rows: shown, total: shown.length, pageSize: Math.max(1, shown.length) })}
              />
            </div>
          </>
        }
      />
    </div>
  );
}

export function DepositsTab() {
  const canWrite = useCanWriteMoney();
  const [status, setStatus] = React.useState<"" | DepositStatus | "open">("open");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  React.useEffect(() => setPage(1), [status]);

  const filter = {
    status: status === "open" ? (["declared", "verified"] as DepositStatus[]) : status ? [status] : undefined,
  };
  const list = useDepositPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];
  const opened = rows.find((r) => r.id === openId) ?? null;

  const columns: Column<Deposit>[] = [
    { key: "code", header: "Deposit", width: "w-[160px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "date", header: "Date", width: "w-[110px]", cell: (r) => date(r.depositDate) },
    { key: "rider", header: "Rider", cell: (r) => r.riderName },
    { key: "branch", header: "Branch", width: "w-[140px]", className: "font-mono text-[12px]", cell: (r) => r.branchId },
    { key: "status", header: "Status", width: "w-[110px]", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "expected", header: "Expected", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.expectedCents) },
    { key: "declared", header: "Declared", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.declaredCents) },
    { key: "counted", header: "Counted", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.countedCents) },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-[12px]",
      cell: (r) => <span className={r.varianceCents ? "text-status-bad" : "text-muted-foreground"}>{r.varianceCents === null ? "—" : amount(r.varianceCents)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The deposit register could not be loaded." : null}
        emptyTitle="No deposits match"
        emptyDescription={status === "open" ? "Nothing is waiting to be counted or banked." : "No deposit has this status."}
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[220px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Deposit status">
                <option value="open">Waiting (declared + verified)</option>
                <option value="declared">Declared — to count</option>
                <option value="verified">Verified — to bank</option>
                <option value="banked">Banked</option>
                <option value="rejected">Rejected</option>
                <option value="">All</option>
              </Select>
            </Field>
            <Button variant="outline" size="sm" onClick={() => setStatus("open")}>
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto">
              <ExportCsvButton<Deposit>
                filename={`natex-deposits-${colomboToday()}.csv`}
                header={["code", "date", "rider", "branch", "status", "expected_lkr", "declared_lkr", "counted_lkr", "variance_lkr", "variance_reason", "bank_ref", "bank_account", "banked_at", "verified_by"]}
                toRow={(r) => [
                  r.code,
                  r.depositDate,
                  r.riderName,
                  r.branchId,
                  r.status,
                  centsToRupees(r.expectedCents),
                  centsToRupees(r.declaredCents),
                  r.countedCents === null ? "" : centsToRupees(r.countedCents),
                  r.varianceCents === null ? "" : centsToRupees(r.varianceCents),
                  r.varianceReason ?? "",
                  r.bankRef ?? "",
                  r.bankAccount ?? "",
                  r.bankedAt ? dateTime(r.bankedAt) : "",
                  r.verifiedByName ?? "",
                ]}
                fetchPage={(p) => client.cod.depositPage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
              />
            </div>
          </>
        }
      />
      <DepositDrawer deposit={opened} canWrite={canWrite} onClose={() => setOpenId(null)} />
    </div>
  );
}

function DepositDrawer({ deposit, canWrite, onClose }: { deposit: Deposit | null; canWrite: boolean; onClose: () => void }) {
  const counted = useRupees();
  const [reason, setReason] = React.useState("");
  const [bankRef, setBankRef] = React.useState("");
  const [bankAccount, setBankAccount] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "verify" | "bank">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const { setText } = counted;

  React.useEffect(() => {
    setText(deposit ? centsToRupees(deposit.declaredCents) : "");
    setReason("");
    setBankRef("");
    setBankAccount("");
    setConfirm(null);
    setError(null);
    setDone(null);
  }, [deposit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fail = (m: string) => {
    setConfirm(null);
    setDone(null);
    setError(m);
  };
  const verify = useVerifyDeposit({
    onSuccess: (r) => {
      setConfirm(null);
      setError(null);
      setDone(
        r.varianceCents === 0
          ? `Counted ${money(r.deposit.countedCents)} — matches the collections.`
          : `Counted ${money(r.deposit.countedCents)}. Variance ${money(r.varianceCents)} posted to cash variance and the merchant's payout is held until it is explained.`,
      );
    },
    onError: fail,
  });
  const bank = useBankDeposit({
    onSuccess: (r) => {
      setConfirm(null);
      setError(null);
      setDone(`Banked under ${r.deposit.bankRef}. ${r.accruals.length} merchant accrual(s) posted.`);
    },
    onError: fail,
  });

  const variancePreview = deposit && counted.cents !== null ? counted.cents - deposit.expectedCents : null;

  return (
    <Drawer
      open={Boolean(deposit)}
      onOpenChange={(next) => !next && onClose()}
      title={deposit?.code ?? "Deposit"}
      subtitle={deposit ? `${deposit.riderName} · ${date(deposit.depositDate)}` : undefined}
    >
      {deposit ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={deposit.status} />
          </div>
          <section className="grid grid-cols-3 gap-3 rounded-md border p-3">
            <Figure label="Expected" cents={deposit.expectedCents} hint="What the parcels say" />
            <Figure label="Declared" cents={deposit.declaredCents} hint="What the rider said" />
            <Figure label="Counted" cents={deposit.countedCents} tone={deposit.varianceCents ? "bad" : undefined} hint={deposit.varianceCents ? `Variance ${money(deposit.varianceCents)}` : undefined} />
          </section>
          <KeyValueGrid>
            <KeyValue label="Branch" mono>{deposit.branchId}</KeyValue>
            <KeyValue label="Declared by">{deposit.createdByName ?? deposit.riderName}</KeyValue>
            <KeyValue label="Verified by">{deposit.verifiedByName ?? "—"}</KeyValue>
            <KeyValue label="Verified" mono>{deposit.verifiedAt ? dateTime(deposit.verifiedAt) : "—"}</KeyValue>
            <KeyValue label="Bank ref" mono>{deposit.bankRef ?? "—"}</KeyValue>
            <KeyValue label="Bank account" mono>{deposit.bankAccount ?? "—"}</KeyValue>
            {deposit.varianceReason ? <KeyValue label="Variance reason" className="col-span-2">{deposit.varianceReason}</KeyValue> : null}
          </KeyValueGrid>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {canWrite && deposit.status === "declared" && !done ? (
            <section className="space-y-3 border-t pt-4">
              <SectionTitle>Count the cash · checkpoint 2</SectionTitle>
              <Field label="Counted (Rs.)" error={counted.error ?? undefined}>
                <RupeeInput value={counted.text} onChange={counted.setText} label="Counted amount in rupees" />
              </Field>
              {variancePreview !== null && variancePreview !== 0 ? (
                <p className="text-[12px] text-status-bad">
                  {variancePreview < 0 ? "Short" : "Over"} by {money(Math.abs(variancePreview))} against the collections. A reason is required.
                </p>
              ) : null}
              <Field label="Variance reason" hint="Required when the count differs from the collections or the declaration.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Rs. 500 note found torn, rejected by cashier" />
              </Field>
              <Button size="sm" disabled={counted.cents === null || counted.text.trim() === ""} onClick={() => setConfirm("verify")}>
                <Scale aria-hidden />
                Record count
              </Button>
            </section>
          ) : null}

          {canWrite && deposit.status === "verified" && !done ? (
            <section className="space-y-3 border-t pt-4">
              <SectionTitle>Bank the cash · checkpoint 3</SectionTitle>
              <Field label="Bank slip reference">
                <Input value={bankRef} onChange={(e) => setBankRef(e.target.value)} className="font-mono" placeholder="BOC-SLIP-004512" />
              </Field>
              <Field label="NatEx account">
                <Input value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} className="font-mono" placeholder="BOC 0071234567" />
              </Field>
              <Button size="sm" disabled={!bankRef.trim() || !bankAccount.trim()} onClick={() => setConfirm("bank")}>
                <Landmark aria-hidden />
                Record banking
              </Button>
            </section>
          ) : null}

          <ConfirmDialog
            open={confirm === "verify"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Record this count?"
            objectName={deposit.code}
            destructive={false}
            confirmLabel={`Record ${counted.cents === null ? "" : money(counted.cents)}`}
            pending={verify.isPending}
            body="The DEPOSIT entries are posted for what was counted, and the rider's cash liability drops by the same amount. A count cannot be edited afterwards."
            onConfirm={() =>
              counted.cents !== null &&
              verify.mutate({ depositId: deposit.id, countedCents: counted.cents, varianceReason: reason.trim() || undefined })
            }
          />
          <ConfirmDialog
            open={confirm === "bank"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Record this banking?"
            objectName={deposit.code}
            destructive={false}
            confirmLabel="Record banking"
            pending={bank.isPending}
            body={`${money(deposit.countedCents)} moves from the branch safe to the bank, and each merchant's share becomes payable.`}
            onConfirm={() => bank.mutate({ depositId: deposit.id, bankRef: bankRef.trim(), bankAccount: bankAccount.trim() })}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
