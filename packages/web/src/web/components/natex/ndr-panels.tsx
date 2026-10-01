import * as React from "react";
import { AlertTriangle, RotateCcw, Search, Undo2 } from "lucide-react";
import { client } from "@/lib/api";
import { colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { ExportCsvButton } from "@/components/natex/export-csv";
import type { Role } from "@/lib/session";
import {
  useNdr,
  useNdrClose,
  useNdrCounts,
  useNdrInstruct,
  useNdrPage,
  useRto,
  useRtoCounts,
  useRtoDeliver,
  useRtoDispatch,
  useRtoInitiate,
  useRtoPage,
  type NdrQueueRow,
  type NdrState,
  type RtoQueueRow,
  type RtoState,
} from "@/queries/ndr";

/**
 * The NDR queue and the RTO register (PROJECT.md §8 NDR/SLA, §6 RTO, §10 M3).
 *
 * Shared by the ops desk (/ops/ndr) and the merchant portal (/merchant/ndr):
 * the server scopes every read (§5) and refuses every write a role may not
 * make, so these panels only decide which buttons to *offer*, matching the
 * route gates in api/routes/ndr.ts so nobody is shown a 403:
 *   - instruct:     merchant (own rows), ops, admin           (ndrProc)
 *   - close:        ops, admin                                (opsProc)
 *   - rtoInitiate:  ops, admin                                (opsProc)
 *   - rtoDispatch:  transport, ops, admin                     (transportProc)
 *   - rtoDeliver:   rider, ops, admin                         (doorstepProc)
 */

const NDR_VARIANT: Record<string, "warn" | "brand" | "good" | "muted" | "bad"> = {
  open: "bad",
  instructed: "brand",
  reattempt_scheduled: "warn",
  rto: "muted",
  resolved: "good",
  closed: "muted",
};

const RTO_VARIANT: Record<string, "warn" | "brand" | "good" | "muted"> = {
  initiated: "warn",
  in_transit: "brand",
  delivered: "good",
  closed: "muted",
};

const LIVE: NdrState[] = ["open", "instructed", "reattempt_scheduled"];
const PAGE_SIZE = 25;

type NdrFilter = "live" | "all" | NdrState;

function ndrStates(filter: NdrFilter): NdrState[] | undefined {
  if (filter === "all") return undefined;
  if (filter === "live") return LIVE;
  return [filter];
}

function slaText(row: { overdue: boolean; hoursLeft: number | null; state: string }) {
  if (!LIVE.includes(row.state as NdrState)) return "—";
  if (row.hoursLeft === null) return "no clock";
  if (row.overdue) return `${Math.abs(row.hoursLeft).toFixed(1)} h over`;
  return `${row.hoursLeft.toFixed(1)} h left`;
}

// =========================================================================
// NDR queue
// =========================================================================

export function NdrQueue({ role, merchantView = false }: { role: Role; merchantView?: boolean }) {
  const [stateFilter, setStateFilter] = React.useState<NdrFilter>("live");
  const [overdueOnly, setOverdueOnly] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const debounced = useDebounced(search.trim(), 250);
  React.useEffect(() => setPage(1), [stateFilter, overdueOnly, debounced]);

  const filter = {
    state: ndrStates(stateFilter),
    overdueOnly,
    search: debounced || undefined,
  };
  const list = useNdrPage({ ...filter, page, pageSize: PAGE_SIZE });
  const counts = useNdrCounts();
  const tally = counts.data;

  const columns: Column<NdrQueueRow>[] = [
    { key: "awb", header: "AWB", width: "w-[140px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    ...(merchantView
      ? []
      : [
          {
            key: "merchant",
            header: "Merchant",
            cell: (r: NdrQueueRow) => <span className="text-[13px]">{r.merchantName ?? r.merchantId}</span>,
          } satisfies Column<NdrQueueRow>,
        ]),
    {
      key: "reason",
      header: "Last failure",
      cell: (r) => (
        <span className="text-[13px]">
          {r.lastReasonLabel ?? r.lastReasonCode ?? "—"}
          <span className="ml-1 text-muted-foreground">· attempt {r.attempts}</span>
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      width: "w-[150px]",
      cell: (r) => <Badge variant={NDR_VARIANT[r.state] ?? "muted"}>{humanise(r.state)}</Badge>,
    },
    { key: "raised", header: "Raised", width: "w-[150px]", className: "font-mono text-[12px]", cell: (r) => dateTime(r.raisedAt) },
    {
      key: "sla",
      header: "SLA",
      width: "w-[120px]",
      align: "right",
      className: "font-mono text-[12px]",
      cell: (r) => <span className={r.overdue ? "font-semibold text-status-bad" : ""}>{slaText(r)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricTile label="Awaiting answer" value={tally?.open ?? "—"} />
        <MetricTile
          label="Overdue"
          value={tally?.overdue ?? "—"}
          accent={tally && tally.overdue > 0 ? "var(--color-status-bad)" : undefined}
          hint={overdueOnly ? "Showing overdue only" : "Show only these"}
          active={overdueOnly}
          onClick={() => setOverdueOnly((v) => !v)}
        />
        <MetricTile label="Instructed" value={tally?.instructed ?? "—"} />
        <MetricTile label="Reattempt booked" value={tally?.reattemptScheduled ?? "—"} />
        <MetricTile label="Sent back (RTO)" value={tally?.rto ?? "—"} />
        <MetricTile label="Resolved / closed" value={tally ? tally.resolved + tally.closed : "—"} />
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The NDR queue could not be loaded." : null}
        emptyTitle={overdueOnly ? "Nothing overdue" : "No NDRs match"}
        emptyDescription={
          stateFilter === "live" && !overdueOnly
            ? merchantView
              ? "No failed delivery is waiting on your answer."
              : "No failed delivery is waiting on a merchant at this branch."
            : "Nothing matches these filters."
        }
        onRowClick={(r) => setOpenId(r.id)}
        rowClassName={(r) => (r.overdue ? "bg-status-bad/5" : "")}
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? PAGE_SIZE,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <Field label="Search" className="w-[220px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="AWB"
                  className="pl-8 font-mono"
                  aria-label="Search NDRs by AWB"
                />
              </div>
            </Field>
            <Field label="State" className="w-[210px]">
              <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as NdrFilter)} aria-label="NDR state">
                <option value="live">Live (needs an answer or a run)</option>
                <option value="open">Open</option>
                <option value="instructed">Instructed</option>
                <option value="reattempt_scheduled">Reattempt booked</option>
                <option value="rto">Sent back</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </Select>
            </Field>
            <label className="flex h-9 items-center gap-2 self-end text-[13px]">
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
                setStateFilter("live");
                setOverdueOnly(false);
                setSearch("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
            <div className="ml-auto self-end">
              <ExportCsvButton<NdrQueueRow>
                filename={`natex-ndr-${colomboToday()}.csv`}
                header={[
                  "awb",
                  "merchant",
                  "state",
                  "attempts",
                  "last_reason",
                  "raised_at",
                  "sla_due_at",
                  "overdue",
                  "instruction",
                  "instructed_by",
                ]}
                toRow={(r) => [
                  r.awb,
                  r.merchantName ?? r.merchantId,
                  r.state,
                  r.attempts,
                  r.lastReasonLabel ?? r.lastReasonCode ?? "",
                  dateTime(r.raisedAt),
                  r.slaDueAt ? dateTime(r.slaDueAt) : "",
                  r.overdue ? "yes" : "no",
                  r.merchantInstruction ?? "",
                  r.instructedByName ?? "",
                ]}
                fetchPage={(p) => client.ndr.page({ ...filter, page: p, pageSize: 100 })}
              />
            </div>
          </>
        }
      />

      <NdrDrawer ndrId={openId} role={role} onClose={() => setOpenId(null)} />
    </div>
  );
}

type Instruction = "reattempt" | "rto" | "hold" | "address_change";

const INSTRUCTION_LABEL: Record<Instruction, string> = {
  reattempt: "Try again",
  address_change: "Correct the address / phone, then try again",
  hold: "Hold at the hub",
  rto: "Return it to me (RTO)",
};

export function NdrDrawer({ ndrId, role, onClose }: { ndrId: string | null; role: Role; onClose: () => void }) {
  const detail = useNdr(ndrId);
  const data = detail.data;
  const row = data?.ndr;

  const [instruction, setInstruction] = React.useState<Instruction>("reattempt");
  const [reattemptDate, setReattemptDate] = React.useState("");
  const [newAddress, setNewAddress] = React.useState("");
  const [newPhone, setNewPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [closeReason, setCloseReason] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "rto" | "close">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    setInstruction("reattempt");
    setReattemptDate("");
    setNewAddress("");
    setNewPhone("");
    setNotes("");
    setCloseReason("");
    setConfirm(null);
    setError(null);
    setDone(null);
  }, [ndrId]);

  const instruct = useNdrInstruct({
    onSuccess: (r) => {
      setConfirm(null);
      setError(null);
      setDone(
        r.rto
          ? `Return started — ${r.parcel.awb} is now ${humanise(r.parcel.status)}.`
          : `Instruction recorded — ${r.parcel.awb} is now ${humanise(r.parcel.status)}.`,
      );
    },
    onError: (m) => {
      setConfirm(null);
      setDone(null);
      setError(m);
    },
  });
  const close = useNdrClose({
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      setDone("NDR closed. The reason is on the record.");
    },
    onError: (m) => {
      setConfirm(null);
      setDone(null);
      setError(m);
    },
  });

  const live = row ? LIVE.includes(row.state as NdrState) : false;
  const outForDelivery = data?.parcel.status === "OutForDelivery";
  const mayInstruct = role === "merchant" || role === "ops" || role === "admin";
  const mayClose = role === "ops" || role === "admin";
  const addressInvalid = instruction === "address_change" && !newAddress.trim() && !newPhone.trim();

  const submitInstruction = () => {
    if (!row) return;
    setError(null);
    instruct.mutate({
      ndrId: row.id,
      instruction,
      notes: notes.trim() || null,
      newAddress: instruction === "address_change" ? newAddress.trim() || null : null,
      newPhone: instruction === "address_change" ? newPhone.trim() || null : null,
      reattemptDate:
        (instruction === "reattempt" || instruction === "address_change") && reattemptDate ? reattemptDate : null,
    });
  };

  return (
    <Drawer
      open={Boolean(ndrId)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={row ? `NDR · ${row.awb}` : "NDR"}
      subtitle={data ? `${data.merchantName ?? row?.merchantId} · attempt ${row?.attempts}` : undefined}
    >
      {detail.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading the report…</p>
      ) : detail.isError ? (
        <ErrorNote>That NDR could not be read. It may belong to another branch or merchant.</ErrorNote>
      ) : !row || !data ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={NDR_VARIANT[row.state] ?? "muted"}>{humanise(row.state)}</Badge>
            <StatusPill status={data.parcel.status} />
            {data.overdue ? (
              <Badge variant="bad">
                <AlertTriangle className="size-3" aria-hidden />
                SLA breached
              </Badge>
            ) : null}
          </div>

          <KeyValueGrid>
            <KeyValue label="Consignee">{data.parcel.consigneeName}</KeyValue>
            <KeyValue label="Phone" mono>
              {data.parcel.consigneePhone}
            </KeyValue>
            <KeyValue label="Address">{data.parcel.destAddress}</KeyValue>
            <KeyValue label="COD">{data.parcel.codAmountCents > 0 ? money(data.parcel.codAmountCents) : "Prepaid"}</KeyValue>
            <KeyValue label="Last failure">{row.lastReasonLabel ?? row.lastReasonCode ?? "—"}</KeyValue>
            <KeyValue label="Attempts">{row.attempts}</KeyValue>
            <KeyValue label="Raised" mono>
              {dateTime(row.raisedAt)}
            </KeyValue>
            <KeyValue label="Answer due" mono>
              {row.slaDueAt ? dateTime(row.slaDueAt) : "—"}
            </KeyValue>
          </KeyValueGrid>

          {row.merchantInstruction ? (
            <section className="rounded-md border p-3 text-[13px]">
              <p className="label-xs text-muted-foreground">Instruction on record</p>
              <p className="mt-1">
                <span className="font-medium">{INSTRUCTION_LABEL[row.merchantInstruction as Instruction] ?? humanise(row.merchantInstruction)}</span>
                {row.reattemptDate ? ` on ${date(row.reattemptDate)}` : ""}
                {row.instructedByName ? ` — ${row.instructedByName}` : ""}
                {row.instructedAt ? `, ${dateTime(row.instructedAt)}` : ""}
              </p>
              {row.newAddress ? <p className="mt-1 text-muted-foreground">New address: {row.newAddress}</p> : null}
              {row.newPhone ? <p className="mt-1 font-mono text-muted-foreground">New phone: {row.newPhone}</p> : null}
              {row.instructionNotes ? <p className="mt-1 text-muted-foreground">“{row.instructionNotes}”</p> : null}
            </section>
          ) : null}

          {row.closeReason ? (
            <section className="rounded-md border p-3 text-[13px]">
              <p className="label-xs text-muted-foreground">Closed</p>
              <p className="mt-1">{row.closeReason}</p>
              <p className="mt-1 text-muted-foreground">
                {row.actionedByName ?? ""} {row.closedAt ? `· ${dateTime(row.closedAt)}` : ""}
              </p>
            </section>
          ) : null}

          {data.rto ? (
            <section className="rounded-md border p-3 text-[13px]">
              <p className="label-xs text-muted-foreground">Return to merchant</p>
              <p className="mt-1 flex items-center gap-2">
                <Badge variant={RTO_VARIANT[data.rto.state] ?? "muted"}>{humanise(data.rto.state)}</Badge>
                <span className="text-muted-foreground">{data.rto.reason}</span>
              </p>
            </section>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {live && mayInstruct ? (
            outForDelivery ? (
              <p className="rounded-md border border-dashed p-3 text-[13px] text-muted-foreground">
                The parcel is on a van right now. Wait for the attempt to be recorded, then answer the NDR it raises.
              </p>
            ) : (
              <form
                className="space-y-3 border-t pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (addressInvalid) return;
                  if (instruction === "rto") setConfirm("rto");
                  else submitInstruction();
                }}
              >
                <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {role === "merchant" ? "Your instruction" : "Instruct on the merchant's behalf"}
                </h4>
                <fieldset className="space-y-1.5" aria-label="Instruction">
                  {(Object.keys(INSTRUCTION_LABEL) as Instruction[]).map((key) => (
                    <label key={key} className="flex items-center gap-2 text-[13px]">
                      <input
                        type="radio"
                        name="instruction"
                        value={key}
                        aria-label={INSTRUCTION_LABEL[key]}
                        checked={instruction === key}
                        onChange={() => setInstruction(key)}
                        className="size-4 accent-[var(--color-brand)]"
                      />
                      {INSTRUCTION_LABEL[key]}
                    </label>
                  ))}
                </fieldset>
                {instruction === "address_change" ? (
                  <>
                    <Field label="New address">
                      <Textarea value={newAddress} onChange={(e) => setNewAddress(e.target.value)} rows={2} />
                    </Field>
                    <Field label="New phone" hint="Sri Lankan mobile, e.g. 0771234567. Address, phone or both.">
                      <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} className="font-mono" />
                    </Field>
                  </>
                ) : null}
                {instruction === "reattempt" || instruction === "address_change" ? (
                  <Field label="Reattempt on" hint="Optional. Blank means the next run.">
                    <Input
                      type="date"
                      min={colomboToday()}
                      value={reattemptDate}
                      onChange={(e) => setReattemptDate(e.target.value)}
                    />
                  </Field>
                ) : null}
                <Field label="Notes" hint="Optional — shown to the rider.">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Call before arriving; gate code 4411." />
                </Field>
                {addressInvalid ? <p className="text-[12px] text-status-bad">Give a new address, a new phone, or both.</p> : null}
                <Button
                  type="submit"
                  size="sm"
                  variant={instruction === "rto" ? "destructive" : "default"}
                  pending={instruct.isPending && confirm === null}
                  disabled={addressInvalid}
                >
                  Send instruction
                </Button>
              </form>
            )
          ) : null}

          {live && mayClose ? (
            <section className="space-y-2 border-t pt-4">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Close without an instruction
              </h4>
              <Field label="Reason" hint="At least 10 characters. A duplicate, or settled off-system — say which.">
                <Textarea value={closeReason} onChange={(e) => setCloseReason(e.target.value)} rows={2} />
              </Field>
              <Button
                size="sm"
                variant="destructive"
                disabled={closeReason.trim().length < 10}
                onClick={() => setConfirm("close")}
              >
                Close NDR
              </Button>
            </section>
          ) : null}

          <ConfirmDialog
            open={confirm === "rto"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Send this parcel back?"
            objectName={row.awb}
            confirmLabel="Return to merchant"
            pending={instruct.isPending}
            body="The delivery is abandoned and the parcel starts its return leg. An RTO cannot be undone, and the RTO fee applies at settlement."
            onConfirm={submitInstruction}
          />
          <ConfirmDialog
            open={confirm === "close"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Close this NDR?"
            objectName={row.awb}
            confirmLabel="Close NDR"
            pending={close.isPending}
            body={`It leaves the queue with no instruction. Reason on record: “${closeReason.trim()}”.`}
            onConfirm={() => close.mutate({ ndrId: row.id, closeReason: closeReason.trim() })}
          />
        </div>
      )}
    </Drawer>
  );
}

// =========================================================================
// RTO register
// =========================================================================

type RtoFilter = "live" | "all" | RtoState;

function rtoStates(filter: RtoFilter): RtoState[] | undefined {
  if (filter === "all") return undefined;
  if (filter === "live") return ["initiated", "in_transit"];
  return [filter];
}

export function RtoQueue({ role, merchantView = false }: { role: Role; merchantView?: boolean }) {
  const [stateFilter, setStateFilter] = React.useState<RtoFilter>("live");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [initiating, setInitiating] = React.useState(false);

  const debounced = useDebounced(search.trim(), 250);
  React.useEffect(() => setPage(1), [stateFilter, debounced]);

  const filter = { state: rtoStates(stateFilter), search: debounced || undefined };
  const list = useRtoPage({ ...filter, page, pageSize: PAGE_SIZE });
  const counts = useRtoCounts();
  const tally = counts.data;
  const mayInitiate = role === "ops" || role === "admin";

  const columns: Column<RtoQueueRow>[] = [
    { key: "awb", header: "AWB", width: "w-[140px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    ...(merchantView
      ? []
      : [
          {
            key: "merchant",
            header: "Merchant",
            cell: (r: RtoQueueRow) => <span className="text-[13px]">{r.merchantName ?? r.merchantId}</span>,
          } satisfies Column<RtoQueueRow>,
        ]),
    { key: "trigger", header: "Why", cell: (r) => <span className="text-[13px]">{humanise(r.trigger)} — <span className="text-muted-foreground">{r.reason}</span></span> },
    {
      key: "state",
      header: "State",
      width: "w-[120px]",
      cell: (r) => <Badge variant={RTO_VARIANT[r.state] ?? "muted"}>{humanise(r.state)}</Badge>,
    },
    { key: "started", header: "Started", width: "w-[150px]", className: "font-mono text-[12px]", cell: (r) => dateTime(r.initiatedAt) },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <MetricTile label="Waiting at hub" value={tally?.initiated ?? "—"} />
        <MetricTile label="On the way back" value={tally?.inTransit ?? "—"} />
        <MetricTile label="Handed back" value={tally?.delivered ?? "—"} />
        <MetricTile label="All returns" value={tally?.total ?? "—"} />
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The returns register could not be loaded." : null}
        emptyTitle="No returns match"
        emptyDescription={stateFilter === "live" ? "No parcel is on its way back right now." : "Nothing matches these filters."}
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? PAGE_SIZE,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <Field label="Search" className="w-[220px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="AWB"
                  className="pl-8 font-mono"
                  aria-label="Search returns by AWB"
                />
              </div>
            </Field>
            <Field label="State" className="w-[200px]">
              <Select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as RtoFilter)} aria-label="Return state">
                <option value="live">Live (hub + on the way)</option>
                <option value="initiated">Waiting at hub</option>
                <option value="in_transit">On the way back</option>
                <option value="delivered">Handed back</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </Select>
            </Field>
            <div className="ml-auto flex items-end gap-2 self-end">
              <ExportCsvButton<RtoQueueRow>
                filename={`natex-rto-${colomboToday()}.csv`}
                header={["awb", "merchant", "trigger", "reason", "state", "attempts", "initiated_at", "dispatched_at", "delivered_at", "received_by"]}
                toRow={(r) => [
                  r.awb,
                  r.merchantName ?? r.merchantId,
                  r.trigger,
                  r.reason,
                  r.state,
                  r.attemptsAtInitiation,
                  dateTime(r.initiatedAt),
                  r.dispatchedAt ? dateTime(r.dispatchedAt) : "",
                  r.deliveredAt ? dateTime(r.deliveredAt) : "",
                  r.receivedByName ?? "",
                ]}
                fetchPage={(p) => client.ndr.rtoPage({ ...filter, page: p, pageSize: 100 })}
              />
              {mayInitiate ? (
                <Button size="sm" onClick={() => setInitiating(true)}>
                  <Undo2 aria-hidden />
                  Start a return
                </Button>
              ) : null}
            </div>
          </>
        }
      />

      {mayInitiate ? (
        <InitiateRtoDialog
          open={initiating}
          onOpenChange={setInitiating}
          onStarted={(id) => {
            setInitiating(false);
            setOpenId(id);
          }}
        />
      ) : null}
      <RtoDrawer rtoId={openId} role={role} onClose={() => setOpenId(null)} />
    </div>
  );
}

function InitiateRtoDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (rtoId: string) => void;
}) {
  const [awb, setAwb] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const start = useRtoInitiate({
    onSuccess: (r) => {
      setConfirming(false);
      setError(null);
      setAwb("");
      setReason("");
      onStarted(r.rto.id);
    },
    onError: (m) => {
      setConfirming(false);
      setError(m);
    },
  });
  const ready = awb.trim().length >= 3 && reason.trim().length >= 10;

  return (
    <>
      <Dialog
        open={open && !confirming}
        onOpenChange={onOpenChange}
        title="Start a return by ops decision"
        description="For a parcel ops has decided not to deliver. The three-attempt rule and refusal codes start returns on their own; this is for the human call."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={!ready} onClick={() => setConfirming(true)}>
              Start return
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="AWB">
            <Input value={awb} onChange={(e) => setAwb(e.target.value.toUpperCase())} className="font-mono" placeholder="NX1234567890" />
          </Field>
          <Field label="Reason" hint="At least 10 characters — it goes on the merchant's statement.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={open && confirming}
        onOpenChange={(o) => !o && setConfirming(false)}
        title="Send this parcel back to the merchant?"
        objectName={awb.trim()}
        confirmLabel="Start return"
        pending={start.isPending}
        body="The parcel moves to RTO initiated. A return cannot be undone, and the merchant is charged the RTO fee."
        onConfirm={() => start.mutate({ awb: awb.trim(), reason: reason.trim() })}
      />
    </>
  );
}

export function RtoDrawer({ rtoId, role, onClose }: { rtoId: string | null; role: Role; onClose: () => void }) {
  const detail = useRto(rtoId);
  const data = detail.data;
  const row = data?.rto;

  const [receivedBy, setReceivedBy] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [confirm, setConfirm] = React.useState<null | "dispatch" | "deliver">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReceivedBy("");
    setNotes("");
    setConfirm(null);
    setError(null);
    setDone(null);
  }, [rtoId]);

  const fail = (m: string) => {
    setConfirm(null);
    setDone(null);
    setError(m);
  };
  const dispatch = useRtoDispatch({
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      setDone("Return leg dispatched.");
    },
    onError: fail,
  });
  const deliver = useRtoDeliver({
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      setDone("Hand-back recorded with a proof of delivery.");
    },
    onError: fail,
  });

  const mayDispatch = role === "transport" || role === "ops" || role === "admin";
  const mayDeliver = role === "rider" || role === "ops" || role === "admin";

  return (
    <Drawer
      open={Boolean(rtoId)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={row ? `Return · ${row.awb}` : "Return"}
      subtitle={data ? (data.merchantName ?? row?.merchantId) : undefined}
    >
      {detail.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading the return…</p>
      ) : detail.isError ? (
        <ErrorNote>That return could not be read. It may belong to another branch or merchant.</ErrorNote>
      ) : !row || !data ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={RTO_VARIANT[row.state] ?? "muted"}>{humanise(row.state)}</Badge>
            {data.parcel ? <StatusPill status={data.parcel.status} /> : null}
          </div>
          <KeyValueGrid>
            <KeyValue label="Trigger">{humanise(row.trigger)}</KeyValue>
            <KeyValue label="Attempts made">{row.attemptsAtInitiation}</KeyValue>
            <KeyValue label="Reason">{row.reason}</KeyValue>
            <KeyValue label="Started by">{row.initiatedByName ?? "system"}</KeyValue>
            <KeyValue label="Started" mono>
              {dateTime(row.initiatedAt)}
            </KeyValue>
            <KeyValue label="Dispatched" mono>
              {row.dispatchedAt ? dateTime(row.dispatchedAt) : "—"}
            </KeyValue>
            <KeyValue label="Handed back" mono>
              {row.deliveredAt ? dateTime(row.deliveredAt) : "—"}
            </KeyValue>
            <KeyValue label="Received by">{row.receivedByName ?? "—"}</KeyValue>
          </KeyValueGrid>
          {data.pod ? (
            <p className="text-[12px] text-muted-foreground">
              Proof of hand-back on record ({humanise(data.pod.method)}), {dateTime(data.pod.ts)}.
            </p>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {row.state === "initiated" && mayDispatch ? (
            <section className="space-y-2 border-t pt-4">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Send it back</h4>
              <Button size="sm" onClick={() => setConfirm("dispatch")}>
                Dispatch return leg
              </Button>
            </section>
          ) : null}

          {row.state === "in_transit" && mayDeliver ? (
            <form
              className="space-y-2 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (receivedBy.trim().length >= 2) setConfirm("deliver");
              }}
            >
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">Hand back to merchant</h4>
              <Field label="Received by" hint="The merchant's staff member who signed it back in.">
                <Input value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} />
              </Field>
              <Field label="Notes">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Button type="submit" size="sm" disabled={receivedBy.trim().length < 2}>
                Record hand-back
              </Button>
            </form>
          ) : null}

          <ConfirmDialog
            open={confirm === "dispatch"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Dispatch the return leg?"
            objectName={row.awb}
            destructive={false}
            confirmLabel="Dispatch"
            pending={dispatch.isPending}
            body="The parcel moves to RTO in transit and leaves this hub's custody."
            onConfirm={() => dispatch.mutate({ rtoId: row.id })}
          />
          <ConfirmDialog
            open={confirm === "deliver"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Record the hand-back?"
            objectName={row.awb}
            destructive={false}
            confirmLabel="Record hand-back"
            pending={deliver.isPending}
            body={`A proof of delivery is written in ${receivedBy.trim()}'s name and the parcel becomes RTO delivered — a terminal state.`}
            onConfirm={() => deliver.mutate({ rtoId: row.id, receivedByName: receivedBy.trim(), notes: notes.trim() || null })}
          />
        </div>
      )}
    </Drawer>
  );
}
