import * as React from "react";
import { Gavel, MessageSquarePlus, RotateCcw, UserCheck, Undo2 } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, dateTime, humanise, money, since } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
import { useDebounced } from "@/lib/hooks";
import { useUser } from "@/components/auth-provider";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ErrorNote, KeyValue, KeyValueGrid, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import {
  useAssignDispute,
  useDispute,
  useDisputeMeta,
  useDisputePage,
  useOpenDispute,
  useResolveDispute,
  useWithdrawDispute,
  type DisputeIn,
  type DisputeRow,
} from "@/queries/disputes";
import { useInvoicePage } from "@/queries/finance";
import { EXPORT_PAGE, MerchantSelect, PAGE_SIZE, RupeeInput, SectionTitle, StatusBadge, useRupees } from "../finance/shared";

/**
 * Dispute queue, claim register and the case drawer — shared by the finance
 * portal (decides cases) and the merchant portal (opens and withdraws its own).
 *
 * Who may do what is the server's rule (§5): a merchant only ever sees its
 * own cases; assigning and deciding is finance only; and whoever opened a case
 * can never decide it. The drawer offers each action only to the role that may
 * take it, and still shows the server's refusal verbatim if one comes back.
 */

type DisputeStatus = NonNullable<NonNullable<DisputeIn<"list">>["status"]>[number];
type DisputeType = DisputeIn<"open">["type"];
type Remedy = NonNullable<DisputeIn<"resolve">["remedy"]>;

export type Mode = "finance" | "merchant";
export type ListView = "queue" | "register" | "all";

function overdue(r: DisputeRow): boolean {
  return (r.status === "open" || r.status === "investigating") && r.slaDueAt !== null && new Date(r.slaDueAt).getTime() < Date.now();
}

export function DisputeList({ mode, view }: { mode: Mode; view: ListView }) {
  const meta = useDisputeMeta();
  const [status, setStatus] = React.useState<"" | DisputeStatus | "live">(view === "register" ? "" : "live");
  const [type, setType] = React.useState<"" | DisputeType>("");
  const [merchantId, setMerchantId] = React.useState("");
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [q, setQ] = React.useState("");
  const debouncedQ = useDebounced(q.trim(), 300);
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [opening, setOpening] = React.useState(false);
  React.useEffect(() => setPage(1), [status, type, merchantId, overdueOnly, debouncedQ]);

  const filter = {
    status: status === "live" ? (["open", "investigating"] as DisputeStatus[]) : status ? [status] : undefined,
    type: type ? [type] : undefined,
    register: view === "register" ? true : undefined,
    merchantId: mode === "finance" && merchantId ? merchantId : undefined,
    overdueOnly: overdueOnly || undefined,
    q: debouncedQ || undefined,
  };
  const list = useDisputePage(filter, page, PAGE_SIZE);
  const rows = list.data?.rows ?? [];
  const types = meta.data?.types ?? [];
  const label = (t: string) => types.find((x) => x.type === t)?.label ?? humanise(t);

  const columns: Column<DisputeRow>[] = [
    { key: "code", header: "Case", width: "w-[150px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "opened", header: "Opened", width: "w-[120px]", className: "text-[12px]", cell: (r) => since(r.createdAt) },
    ...(mode === "finance" ? [{ key: "merchant", header: "Merchant", width: "w-[180px]", cell: (r: DisputeRow) => r.merchantName } satisfies Column<DisputeRow>] : []),
    { key: "type", header: "Type", width: "w-[150px]", cell: (r) => label(r.type) },
    { key: "awb", header: "AWB", width: "w-[130px]", cell: (r) => (r.awb ? <MonoCell>{r.awb}</MonoCell> : "—") },
    { key: "desc", header: "What happened", cell: (r) => <span className="line-clamp-1 text-[12px]">{r.description}</span> },
    { key: "claim", header: "Claimed", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => amount(r.claimAmountCents) },
    { key: "approved", header: "Approved", align: "right", width: "w-[120px]", className: "font-mono text-[12px]", cell: (r) => (r.approvedAmountCents === null ? "—" : amount(r.approvedAmountCents)) },
    {
      key: "status",
      header: "Status",
      width: "w-[150px]",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={r.status} />
          {overdue(r) ? <Badge variant="bad">overdue</Badge> : null}
        </span>
      ),
    },
    ...(mode === "finance" ? [{ key: "owner", header: "Owner", width: "w-[140px]", className: "text-[12px]", cell: (r: DisputeRow) => r.assignedToName ?? "Unassigned" } satisfies Column<DisputeRow>] : []),
  ];

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "Disputes could not be loaded." : null}
        emptyTitle={view === "register" ? "No claims on the register" : "No disputes match"}
        emptyDescription={status === "live" ? "No case is waiting on a decision." : undefined}
        onRowClick={(r) => setOpenId(r.id)}
        rowClassName={(r) => (overdue(r) ? "bg-status-bad/5" : undefined)}
        pagination={{ page, pageSize: PAGE_SIZE, total: list.data?.total ?? 0, onPageChange: setPage }}
        filters={
          <>
            <Field label="Status" className="w-[230px]">
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Dispute status">
                <option value="live">Live (open + investigating)</option>
                {(meta.data?.statuses ?? []).map((s) => (
                  <option key={s} value={s}>
                    {humanise(s)}
                  </option>
                ))}
                <option value="">All</option>
              </Select>
            </Field>
            <Field label="Type" className="w-[170px]">
              <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Dispute type">
                <option value="">Any type</option>
                {types
                  .filter((t) => view !== "register" || t.isClaim)
                  .map((t) => (
                    <option key={t.type} value={t.type}>
                      {t.label}
                    </option>
                  ))}
              </Select>
            </Field>
            {mode === "finance" ? (
              <Field label="Merchant" className="w-[200px]">
                <MerchantSelect value={merchantId} onChange={setMerchantId} allLabel="All merchants" />
              </Field>
            ) : null}
            <Field label="Search" className="w-[180px]">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Case code or AWB" aria-label="Search disputes" />
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
              <input
                type="checkbox"
                aria-label="Overdue only"
                checked={overdueOnly}
                onChange={(e) => setOverdueOnly(e.target.checked)}
                className="size-4 accent-[var(--color-brand)]"
              />
              Overdue only
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus(view === "register" ? "" : "live");
                setType("");
                setMerchantId("");
                setOverdueOnly(false);
                setQ("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={() => setOpening(true)}>
                <MessageSquarePlus aria-hidden />
                {mode === "merchant" ? "Raise a dispute" : "Open a case"}
              </Button>
              <ExportCsvButton<DisputeRow>
                filename={`natex-${view === "register" ? "claims" : "disputes"}-${colomboToday()}.csv`}
                header={["code", "opened_at", "merchant", "type", "awb", "status", "claimed_lkr", "approved_lkr", "remedy", "credit_note_id", "payout_ref", "sla_due", "assigned_to", "resolved_by", "resolved_at", "description", "resolution"]}
                toRow={(r) => [
                  r.code,
                  dateTime(r.createdAt),
                  r.merchantName,
                  r.type,
                  r.awb ?? "",
                  r.status,
                  centsToRupees(r.claimAmountCents),
                  r.approvedAmountCents === null ? "" : centsToRupees(r.approvedAmountCents),
                  r.remedy ?? "",
                  r.creditNoteId ?? "",
                  r.payoutRef ?? "",
                  r.slaDueAt ? dateTime(r.slaDueAt) : "",
                  r.assignedToName ?? "",
                  r.resolvedByName ?? "",
                  r.resolvedAt ? dateTime(r.resolvedAt) : "",
                  r.description,
                  r.resolution ?? "",
                ]}
                fetchPage={async (p) => {
                  const r = await client.disputes.list({ ...filter, limit: EXPORT_PAGE, offset: (p - 1) * EXPORT_PAGE });
                  return { rows: r.rows, total: r.total, pageSize: EXPORT_PAGE };
                }}
              />
            </div>
          </>
        }
      />
      <DisputeDrawer disputeId={openId} mode={mode} onClose={() => setOpenId(null)} />
      <OpenDisputeDrawer
        open={opening}
        mode={mode}
        onClose={() => setOpening(false)}
        onOpened={(id) => {
          setOpening(false);
          setOpenId(id);
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────── one case

type CaseAction = "assign" | "resolve" | "withdraw";

export function DisputeDrawer({ disputeId, mode, onClose }: { disputeId: string | null; mode: Mode; onClose: () => void }) {
  const user = useUser();
  const meta = useDisputeMeta();
  const detail = useDispute(disputeId);
  const d = detail.data;
  const [action, setAction] = React.useState<CaseAction | null>(null);
  const [outcome, setOutcome] = React.useState<"upheld" | "rejected">("upheld");
  const approved = useRupees();
  const [remedy, setRemedy] = React.useState<Remedy>("credit_note");
  const [invoiceId, setInvoiceId] = React.useState("");
  const [payoutRef, setPayoutRef] = React.useState("");
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [confirmDecision, setConfirmDecision] = React.useState(false);
  const { setText: setApproved } = approved;

  React.useEffect(() => {
    setAction(null);
    setConfirmDecision(false);
    setText("");
    setError(null);
    setDone(null);
    setOutcome("upheld");
    setRemedy("credit_note");
    setInvoiceId("");
    setPayoutRef("");
    setApproved("");
  }, [disputeId, setApproved]);

  const invoices = useInvoicePage(
    { merchantId: d?.merchantId, status: ["issued", "part_paid"] },
    1,
    50,
    mode === "finance" && action === "resolve" && Boolean(d?.merchantId),
  );

  const ok = (m: string) => {
    setAction(null);
    setConfirmDecision(false);
    setError(null);
    setDone(m);
  };
  const fail = (m: string) => {
    setAction(null);
    setConfirmDecision(false);
    setDone(null);
    setError(m);
  };
  const assign = useAssignDispute({ onSuccess: (r) => ok(`${r.code} is now with ${r.assignedToName ?? "you"} and under investigation.`), onError: fail });
  const resolve = useResolveDispute({ onSuccess: (r) => ok(`${r.code} ${humanise(r.status)}.${r.approvedAmountCents ? ` ${money(r.approvedAmountCents)} approved.` : ""}`), onError: fail });
  const withdraw = useWithdrawDispute({ onSuccess: (r) => ok(`${r.code} withdrawn.`), onError: fail });
  const pending = assign.isPending || resolve.isPending || withdraw.isPending;

  const live = d && (d.status === "open" || d.status === "investigating");
  const isOpener = d ? d.openedById === user.id : false;
  const typeLabel = d ? (meta.data?.types.find((t) => t.type === d.type)?.label ?? humanise(d.type)) : "";

  const approvedCents = outcome === "upheld" ? (approved.text.trim() === "" ? null : approved.cents) : 0;
  const effectiveRemedy: Remedy = outcome === "rejected" || approvedCents === 0 ? "none" : remedy;
  const resolveValid =
    text.trim().length >= 10 &&
    (outcome === "rejected" ||
      (approvedCents !== null &&
        !approved.error &&
        (effectiveRemedy !== "credit_note" || invoiceId) &&
        (effectiveRemedy !== "bank_transfer" || payoutRef.trim().length >= 6)));

  const run = () => {
    if (!d) return;
    if (action === "assign") assign.mutate({ disputeId: d.id });
    else if (action === "withdraw") withdraw.mutate({ disputeId: d.id, reason: text.trim() });
    else if (action === "resolve")
      resolve.mutate({
        disputeId: d.id,
        outcome,
        approvedAmountCents: outcome === "upheld" ? (approvedCents ?? 0) : undefined,
        resolution: text.trim(),
        remedy: outcome === "upheld" ? effectiveRemedy : undefined,
        invoiceId: effectiveRemedy === "credit_note" ? invoiceId : undefined,
        payoutRef: effectiveRemedy === "bank_transfer" ? payoutRef.trim() : undefined,
      });
  };

  return (
    <Drawer
      open={Boolean(disputeId)}
      onOpenChange={(next) => !next && onClose()}
      title={d?.code ?? "Dispute"}
      subtitle={d ? `${typeLabel} · ${d.merchantName}${d.awb ? ` · ${d.awb}` : ""}` : undefined}
    >
      {detail.isError ? <ErrorNote>This case could not be loaded.</ErrorNote> : null}
      {d ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {overdue(d) ? <Badge variant="bad">past SLA</Badge> : null}
            {d.holdId ? <Badge variant="warn">payout held</Badge> : null}
          </div>
          <p className="whitespace-pre-wrap text-[13px]">{d.description}</p>
          <KeyValueGrid>
            <KeyValue label="Claimed" mono>{money(d.claimAmountCents)}</KeyValue>
            <KeyValue label="Approved" mono>{d.approvedAmountCents === null ? "—" : money(d.approvedAmountCents)}</KeyValue>
            <KeyValue label="Opened by">{d.openedByName ?? "—"}</KeyValue>
            <KeyValue label="Opened" mono>{dateTime(d.createdAt)}</KeyValue>
            <KeyValue label="Decide by" mono>{d.slaDueAt ? dateTime(d.slaDueAt) : "—"}</KeyValue>
            <KeyValue label="Owner">{d.assignedToName ?? "Unassigned"}</KeyValue>
            {d.codAmountCents ? <KeyValue label="Parcel COD" mono>{money(d.codAmountCents)}</KeyValue> : null}
            {d.declaredValueCents ? <KeyValue label="Declared value" mono>{money(d.declaredValueCents)}</KeyValue> : null}
            {d.remedy ? <KeyValue label="Remedy">{humanise(d.remedy)}</KeyValue> : null}
            {d.creditNoteId ? <KeyValue label="Credit note" mono>{d.creditNoteId}</KeyValue> : null}
            {d.payoutRef ? <KeyValue label="Transfer ref" mono>{d.payoutRef}</KeyValue> : null}
            {d.resolvedByName ? <KeyValue label="Decided by">{d.resolvedByName}</KeyValue> : null}
            {d.resolution ? <KeyValue label="Decision" className="col-span-2">{d.resolution}</KeyValue> : null}
          </KeyValueGrid>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {live && mode === "finance" && isOpener ? (
            <p className="rounded-md border border-status-warn/40 bg-status-warn/5 px-3 py-2 text-[12px]">
              You opened this case, so someone else in finance has to decide it.
            </p>
          ) : null}

          {live ? (
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {mode === "finance" && d.assignedToId !== user.id ? (
                <Button size="sm" variant="outline" onClick={() => setAction("assign")}>
                  <UserCheck aria-hidden />
                  {d.assignedToId ? "Take over" : "Pick up"}
                </Button>
              ) : null}
              {mode === "finance" ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setText("");
                    setApproved(centsToRupees(d.claimAmountCents));
                    setAction("resolve");
                  }}
                >
                  <Gavel aria-hidden />
                  Decide
                </Button>
              ) : null}
              {mode === "merchant" || isOpener ? (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setText("");
                    setAction("withdraw");
                  }}
                >
                  <Undo2 aria-hidden />
                  Withdraw
                </Button>
              ) : null}
            </div>
          ) : null}

          {action === "resolve" ? (
            <section className="space-y-3 border-t pt-4">
              <SectionTitle>Decision</SectionTitle>
              <Field label="Outcome">
                <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Outcome">
                  <option value="upheld">Uphold — the merchant is right</option>
                  <option value="rejected">Reject — nothing is owed</option>
                </Select>
              </Field>
              {outcome === "upheld" ? (
                <>
                  <Field label={`Approved amount (Rs., up to ${money(d.claimAmountCents)})`} error={approved.error ?? undefined}>
                    <RupeeInput value={approved.text} onChange={approved.setText} label="Approved amount in rupees" />
                  </Field>
                  {approvedCents ? (
                    <Field label="Paid how">
                      <Select value={remedy} onChange={(e) => setRemedy(e.target.value as Remedy)} aria-label="Remedy">
                        <option value="credit_note">Credit note against an issued invoice</option>
                        <option value="bank_transfer">Bank transfer</option>
                      </Select>
                    </Field>
                  ) : null}
                  {approvedCents && remedy === "credit_note" ? (
                    <Field label="Invoice" hint={invoices.data && invoices.data.rows.length === 0 ? "This merchant has no issued invoice to credit — use a bank transfer." : undefined}>
                      <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} aria-label="Invoice to credit">
                        <option value="">Choose an invoice</option>
                        {(invoices.data?.rows ?? []).map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.code} · {money(i.totalCents - i.paidCents - i.creditedCents)} outstanding
                          </option>
                        ))}
                      </Select>
                    </Field>
                  ) : null}
                  {approvedCents && remedy === "bank_transfer" ? (
                    <Field label="Transfer UTR / reference">
                      <Input value={payoutRef} onChange={(e) => setPayoutRef(e.target.value)} className="font-mono" aria-label="Transfer reference" />
                    </Field>
                  ) : null}
                </>
              ) : null}
              <Field label="Reasoning (at least 10 characters — the merchant sees this)">
                <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
              </Field>
              <div className="flex gap-2">
                <Button size="sm" disabled={!resolveValid} onClick={() => setConfirmDecision(true)}>
                  <Gavel aria-hidden />
                  Record decision
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAction(null)}>
                  Cancel
                </Button>
              </div>
            </section>
          ) : null}

          <ConfirmDialog
            open={confirmDecision && action === "resolve"}
            onOpenChange={(o) => !o && setConfirmDecision(false)}
            title={outcome === "rejected" ? "Reject this case?" : "Uphold this case?"}
            objectName={d.code}
            destructive={outcome === "rejected"}
            confirmLabel={outcome === "rejected" ? "Reject" : approvedCents ? `Uphold · ${money(approvedCents)}` : "Uphold"}
            pending={resolve.isPending}
            body={
              outcome === "rejected"
                ? "The case closes with nothing owed. The merchant sees your reasoning."
                : approvedCents
                  ? `${money(approvedCents)} is owed to ${d.merchantName} by ${effectiveRemedy === "credit_note" ? "credit note" : "bank transfer"}. The decision is final.`
                  : "The case closes upheld with no money owed. The decision is final."
            }
            onConfirm={run}
          />

          <ConfirmDialog
            open={action === "assign" || action === "withdraw"}
            onOpenChange={(o) => !o && setAction(null)}
            title={action === "assign" ? "Pick up this case?" : "Withdraw this dispute?"}
            objectName={d.code}
            destructive={action === "withdraw"}
            confirmLabel={action === "assign" ? "Pick up" : "Withdraw"}
            pending={pending}
            confirmDisabled={action === "withdraw" && text.trim().length < 5}
            body={
              action === "assign" ? (
                "The case moves to investigating with you as owner."
              ) : (
                <div className="space-y-3">
                  <p>A withdrawn case is closed and any payout hold it raised is released.</p>
                  <Field label="Why (at least 5 characters)">
                    <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} />
                  </Field>
                </div>
              )
            }
            onConfirm={run}
          />
        </div>
      ) : null}
    </Drawer>
  );
}

// ─────────────────────────────────────────────────────────── open a case

export function OpenDisputeDrawer({
  open,
  mode,
  onClose,
  onOpened,
}: {
  open: boolean;
  mode: Mode;
  onClose: () => void;
  onOpened: (id: string) => void;
}) {
  const meta = useDisputeMeta();
  const [merchantId, setMerchantId] = React.useState("");
  const [type, setType] = React.useState<DisputeType>("cod_shortfall");
  const [awb, setAwb] = React.useState("");
  const claim = useRupees();
  const [description, setDescription] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { setText } = claim;
  React.useEffect(() => {
    if (!open) return;
    setMerchantId("");
    setType("cod_shortfall");
    setAwb("");
    setText("");
    setDescription("");
    setConfirm(false);
    setError(null);
  }, [open, setText]);

  const opener = useOpenDispute({
    onSuccess: (r) => {
      setConfirm(false);
      onOpened(r.id);
    },
    onError: (m) => {
      setConfirm(false);
      setError(m);
    },
  });
  const valid =
    (mode === "merchant" || merchantId) && description.trim().length >= 10 && claim.cents !== null && !claim.error;

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title={mode === "merchant" ? "Raise a dispute" : "Open a case"} subtitle="Finance answers within the dispute SLA.">
      <div className="space-y-4">
        {mode === "finance" ? (
          <Field label="Merchant">
            <MerchantSelect value={merchantId} onChange={setMerchantId} />
          </Field>
        ) : null}
        <Field label="What kind of problem">
          <Select value={type} onChange={(e) => setType(e.target.value as DisputeType)} aria-label="Dispute type">
            {(meta.data?.types ?? []).map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="AWB" hint="Required for COD shortfall, damage and loss.">
          <Input value={awb} onChange={(e) => setAwb(e.target.value)} className="font-mono" placeholder="NX…" />
        </Field>
        <Field label="Amount claimed (Rs.)" error={claim.error ?? undefined}>
          <RupeeInput value={claim.text} onChange={claim.setText} label="Amount claimed in rupees" />
        </Field>
        <Field label="What happened (at least 10 characters)">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} placeholder="Customer says they paid Rs. 4,500 in cash; we were credited Rs. 4,000." />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button disabled={!valid} onClick={() => setConfirm(true)}>
          <MessageSquarePlus aria-hidden />
          Submit
        </Button>
        <ConfirmDialog
          open={confirm}
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Submit this dispute?"
          objectName={awb.trim() || "this account"}
          destructive={false}
          confirmLabel="Submit"
          pending={opener.isPending}
          body="A COD shortfall or a loss/damage claim holds the parcel's payout until the case is decided."
          onConfirm={() =>
            opener.mutate({
              merchantId: mode === "finance" ? merchantId : undefined,
              awb: awb.trim() || undefined,
              type,
              claimAmountCents: claim.cents ?? 0,
              description: description.trim(),
            })
          }
        />
      </div>
    </Drawer>
  );
}
