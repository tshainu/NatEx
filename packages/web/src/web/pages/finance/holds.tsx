import * as React from "react";
import { Lock, RotateCcw, Unlock } from "lucide-react";
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
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { useClearHold, useHoldPage, useRaiseHold, type FinanceIn, type FinanceOut } from "@/queries/finance";
import {
  EXPORT_PAGE,
  MerchantSelect,
  PAGE_SIZE,
  RupeeInput,
  SectionTitle,
  StatusBadge,
  useCanWriteMoney,
  useMerchantName,
  useRupees,
} from "./shared";

/**
 * Payout holds (§8 "Any open variance blocks that merchant's payout").
 *
 * A parcel hold keeps one parcel's COD out of the next settlement run; a
 * merchant hold stops every run for that merchant. Variances, amount
 * mismatches and disputes raise holds automatically; finance can raise a
 * manual one. Clearing always names a person and says why.
 */

type Hold = FinanceOut<"holdPage">["rows"][number];
type HoldFilter = NonNullable<FinanceIn<"holdPage">>;
type HoldReason = NonNullable<HoldFilter["reason"]>[number];
type HoldScope = NonNullable<HoldFilter["scope"]>;

const REASONS: HoldReason[] = ["amount_mismatch", "deposit_variance", "dispute", "manual"];

export function HoldsTab() {
  const canWrite = useCanWriteMoney();
  const merchantName = useMerchantName();
  const [status, setStatus] = React.useState<"" | "open" | "cleared">("open");
  const [reason, setReason] = React.useState<"" | HoldReason>("");
  const [scope, setScope] = React.useState<"" | HoldScope>("");
  const [merchantId, setMerchantId] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [raising, setRaising] = React.useState(false);
  React.useEffect(() => setPage(1), [status, reason, scope, merchantId]);

  const filter: Omit<HoldFilter, "page" | "pageSize"> = {
    status: status ? [status] : undefined,
    reason: reason ? [reason] : undefined,
    scope: scope || undefined,
    merchantId: merchantId || undefined,
  };
  const list = useHoldPage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];
  const opened = rows.find((r) => r.id === openId) ?? null;

  const columns: Column<Hold>[] = [
    { key: "opened", header: "Opened", width: "w-[140px]", className: "text-[12px]", cell: (r) => since(r.openedAt) },
    { key: "scope", header: "Scope", width: "w-[100px]", cell: (r) => <Badge variant={r.scope === "merchant" ? "bad" : "outline"}>{r.scope}</Badge> },
    { key: "reason", header: "Reason", width: "w-[150px]", cell: (r) => humanise(r.reason) },
    { key: "merchant", header: "Merchant", width: "w-[200px]", cell: (r) => <span className="line-clamp-1">{merchantName(r.merchantId)}</span> },
    { key: "awb", header: "AWB", width: "w-[130px]", cell: (r) => (r.awb ? <MonoCell>{r.awb}</MonoCell> : "—") },
    { key: "detail", header: "Detail", cell: (r) => <span className="line-clamp-1 text-[12px]">{r.detail}</span> },
    { key: "amount", header: "Amount", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => (r.amountCents === null ? "—" : amount(r.amountCents)) },
    { key: "status", header: "Status", width: "w-[100px]", cell: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Holds could not be loaded." : null}
        emptyTitle="No holds match"
        emptyDescription={status === "open" ? "No payout is being held back." : undefined}
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[140px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Hold status">
                <option value="open">Open</option>
                <option value="cleared">Cleared</option>
                <option value="">All</option>
              </Select>
            </Field>
            <Field label="Reason" className="w-[180px]">
              <Select value={reason} onChange={(e) => setReason(e.target.value as typeof reason)} aria-label="Hold reason">
                <option value="">Any reason</option>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    {humanise(r)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Scope" className="w-[140px]">
              <Select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Hold scope">
                <option value="">Any</option>
                <option value="parcel">Parcel</option>
                <option value="merchant">Merchant</option>
              </Select>
            </Field>
            <Field label="Merchant" className="w-[220px]">
              <MerchantSelect value={merchantId} onChange={setMerchantId} allLabel="All merchants" />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("open");
                setReason("");
                setScope("");
                setMerchantId("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {canWrite ? (
                <Button size="sm" onClick={() => setRaising(true)}>
                  <Lock aria-hidden />
                  Raise hold
                </Button>
              ) : null}
              <ExportCsvButton<Hold>
                filename={`natex-holds-${colomboToday()}.csv`}
                header={["id", "status", "scope", "reason", "merchant_id", "awb", "parcel_id", "amount_lkr", "detail", "opened_at", "opened_by", "cleared_at", "cleared_by", "cleared_note"]}
                toRow={(r) => [
                  r.id,
                  r.status,
                  r.scope,
                  r.reason,
                  r.merchantId ?? "",
                  r.awb ?? "",
                  r.parcelId ?? "",
                  r.amountCents === null ? "" : centsToRupees(r.amountCents),
                  r.detail,
                  dateTime(r.openedAt),
                  r.openedByName ?? "",
                  r.clearedAt ? dateTime(r.clearedAt) : "",
                  r.clearedByName ?? "",
                  r.clearedNote ?? "",
                ]}
                fetchPage={(p) => client.finance.holdPage({ ...filter, page: p, pageSize: EXPORT_PAGE })}
              />
            </div>
          </>
        }
      />
      <HoldDrawer hold={opened} canWrite={canWrite} merchantName={merchantName} onClose={() => setOpenId(null)} />
      <RaiseHoldDrawer open={raising} onClose={() => setRaising(false)} />
    </div>
  );
}

function HoldDrawer({
  hold,
  canWrite,
  merchantName,
  onClose,
}: {
  hold: Hold | null;
  canWrite: boolean;
  merchantName: (id: string | null | undefined) => string;
  onClose: () => void;
}) {
  const [note, setNote] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  React.useEffect(() => {
    setNote("");
    setConfirm(false);
    setError(null);
    setDone(null);
  }, [hold?.id]);

  const clear = useClearHold({
    onSuccess: () => {
      setConfirm(false);
      setError(null);
      setDone("Hold cleared. The money is free to go in the next settlement run.");
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });

  return (
    <Drawer
      open={Boolean(hold)}
      onOpenChange={(next) => !next && onClose()}
      title={hold ? `${humanise(hold.reason)} hold` : "Hold"}
      subtitle={hold ? `${hold.scope === "merchant" ? "Every payout" : (hold.awb ?? hold.parcelId ?? "One parcel")} · ${merchantName(hold.merchantId)}` : undefined}
    >
      {hold ? (
        <div className="space-y-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={hold.status} />
            <Badge variant="outline">{hold.scope}</Badge>
          </div>
          <p className="text-[13px]">{hold.detail}</p>
          <KeyValueGrid>
            <KeyValue label="Amount" mono>{hold.amountCents === null ? "—" : money(hold.amountCents)}</KeyValue>
            <KeyValue label="AWB" mono>{hold.awb ?? "—"}</KeyValue>
            <KeyValue label="Opened" mono>{dateTime(hold.openedAt)}</KeyValue>
            <KeyValue label="Opened by">{hold.openedByName ?? "System"}</KeyValue>
            {hold.depositId ? <KeyValue label="Deposit" mono>{hold.depositId}</KeyValue> : null}
            {hold.disputeId ? <KeyValue label="Dispute" mono>{hold.disputeId}</KeyValue> : null}
            {hold.entryId ? <KeyValue label="Ledger entry" mono>{hold.entryId}</KeyValue> : null}
            <KeyValue label="Cleared" mono>{hold.clearedAt ? dateTime(hold.clearedAt) : "—"}</KeyValue>
            <KeyValue label="Cleared by">{hold.clearedByName ?? "—"}</KeyValue>
            {hold.clearedNote ? <KeyValue label="Clearing note" className="col-span-2">{hold.clearedNote}</KeyValue> : null}
          </KeyValueGrid>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}
          {canWrite && hold.status === "open" && !done ? (
            <section className="space-y-3 border-t pt-4">
              <SectionTitle>Clear this hold</SectionTitle>
              <Field label="Why is it safe to release? (required)">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Variance explained: torn note replaced by rider" />
              </Field>
              <Button size="sm" disabled={note.trim().length < 3} onClick={() => setConfirm(true)}>
                <Unlock aria-hidden />
                Clear hold
              </Button>
            </section>
          ) : null}
          <ConfirmDialog
            open={confirm}
            onOpenChange={(o) => !o && setConfirm(false)}
            title="Clear this hold?"
            objectName={hold.awb ?? hold.merchantId ?? hold.id}
            confirmLabel="Clear hold"
            pending={clear.isPending}
            body="The held money becomes payable in the next settlement run. Your name and note are recorded."
            onConfirm={() => clear.mutate({ holdId: hold.id, note: note.trim() })}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

function RaiseHoldDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [scope, setScope] = React.useState<HoldScope>("parcel");
  const [merchantId, setMerchantId] = React.useState("");
  const [awb, setAwb] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const rupees = useRupees();
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const { setText } = rupees;
  React.useEffect(() => {
    if (!open) return;
    setScope("parcel");
    setMerchantId("");
    setAwb("");
    setDetail("");
    setText("");
    setConfirm(false);
    setError(null);
    setDone(null);
  }, [open, setText]);

  const raise = useRaiseHold({
    onSuccess: () => {
      setConfirm(false);
      setError(null);
      setDone("Hold raised. It blocks payout until someone clears it.");
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });
  const valid =
    merchantId && detail.trim().length >= 3 && (scope === "merchant" || awb.trim()) && !rupees.error;

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title="Raise a payout hold" subtitle="Manual holds stop money leaving until cleared.">
      <div className="space-y-4">
        <Field label="Scope">
          <Select value={scope} onChange={(e) => setScope(e.target.value as HoldScope)} aria-label="Hold scope">
            <option value="parcel">One parcel — keep it out of the next run</option>
            <option value="merchant">Merchant — stop every payout</option>
          </Select>
        </Field>
        <Field label="Merchant">
          <MerchantSelect value={merchantId} onChange={setMerchantId} />
        </Field>
        {scope === "parcel" ? (
          <Field label="AWB">
            <Input value={awb} onChange={(e) => setAwb(e.target.value)} className="font-mono" placeholder="NX…" />
          </Field>
        ) : null}
        <Field label="Amount at stake (Rs., optional)" error={rupees.error ?? undefined}>
          <RupeeInput value={rupees.text} onChange={rupees.setText} label="Amount at stake in rupees" />
        </Field>
        <Field label="Why (required)">
          <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} placeholder="Merchant reported the customer paid Rs. 4,500, rider declared Rs. 4,000" />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        {!done ? (
          <Button disabled={!valid} onClick={() => setConfirm(true)}>
            <Lock aria-hidden />
            Raise hold
          </Button>
        ) : null}
        <ConfirmDialog
          open={confirm}
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Raise this hold?"
          objectName={scope === "merchant" ? merchantId : awb.trim()}
          confirmLabel="Raise hold"
          pending={raise.isPending}
          body={scope === "merchant" ? "No settlement run for this merchant can be approved or paid until the hold is cleared." : "This parcel's COD is left out of settlement runs until the hold is cleared."}
          onConfirm={() =>
            raise.mutate({
              scope,
              reason: "manual",
              merchantId,
              awb: scope === "parcel" ? awb.trim() : undefined,
              amountCents: rupees.text.trim() && rupees.cents ? rupees.cents : undefined,
              detail: detail.trim(),
            })
          }
        />
      </div>
    </Drawer>
  );
}
