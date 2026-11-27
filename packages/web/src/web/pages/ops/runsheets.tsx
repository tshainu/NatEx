import * as React from "react";
import { Ban, Plus, RotateCcw, Route, Search, Send, Trash2, Lock, Eye } from "lucide-react";
import { client } from "@/lib/api";
import { amount, colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
import { useDebounced } from "@/lib/hooks";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Drawer } from "@/components/ui/drawer";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Page, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { useAuth } from "@/components/auth-provider";
import {
  useDeliverable,
  useDeliveryCounts,
  useRiders,
  useRunsheet,
  useRunsheetAdd,
  useRunsheetCancel,
  useRunsheetClose,
  useRunsheetCreate,
  useRunsheetDispatch,
  useRunsheetOptimise,
  useRunsheetPage,
  useRiderOpenRunsheets,
  useRunsheetRemove,
  type DeliveryOut,
  type RunsheetStatus,
} from "@/queries/delivery";

/**
 * Runsheets — the ops desk's view of the last mile (PROJECT.md §10 M3).
 *
 * A runsheet is one rider's van for one day: the stops, the order they run in,
 * and the cash the rider is accountable for when they come back. The rider's
 * phone works the run; this screen builds it, hands it over, and closes it.
 *
 * Who may do what is the server's decision, not this file's (§5/§6):
 *   - build, order and dispatch: transport, ops, admin (a rider never loads
 *     their own van — OutForDelivery is a hub transition)
 *   - close, and force-close with write-offs: ops and admin only
 * The buttons are shaped to match so nobody is offered a 403.
 */

type RunsheetRow = DeliveryOut<"runsheetPage">["rows"][number];
type RunsheetDetail = DeliveryOut<"runsheetGet">;
type Stop = RunsheetDetail["items"][number];

const STATUS_VARIANT: Record<string, "brand" | "warn" | "good" | "muted"> = {
  draft: "muted",
  dispatched: "warn",
  closed: "good",
  cancelled: "muted",
};

const STOP_VARIANT: Record<string, "muted" | "good" | "bad" | "warn"> = {
  pending: "warn",
  delivered: "good",
  failed: "bad",
  removed: "muted",
};

type StatusFilter = "live" | "all" | RunsheetStatus;

function statusesFor(filter: StatusFilter): RunsheetStatus[] | undefined {
  if (filter === "all") return undefined;
  if (filter === "live") return ["draft", "dispatched"];
  return [filter];
}

const PAGE_SIZE = 25;

export default function OpsRunsheets() {
  const { session } = useAuth();
  const role = session!.user.role;
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("live");
  const [runDate, setRunDate] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [viewCleared, setViewCleared] = React.useState(false);

  const debounced = useDebounced(search.trim(), 250);
  React.useEffect(() => setPage(1), [statusFilter, runDate, debounced]);

  const filter = {
    status: statusesFor(statusFilter),
    runDate: runDate || undefined,
    search: debounced || undefined,
  };
  const list = useRunsheetPage({ ...filter, page, pageSize: PAGE_SIZE });
  const counts = useDeliveryCounts();
  const tally = counts.data;

  const columns: Column<RunsheetRow>[] = [
    {
      key: "code",
      header: "Runsheet",
      width: "w-[150px]",
      cell: (r) => <MonoCell>{r.code}</MonoCell>,
    },
    { key: "date", header: "Run date", width: "w-[110px]", cell: (r) => date(r.runDate) },
    { key: "rider", header: "Rider", cell: (r) => <span className="text-[13px]">{r.riderName}</span> },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (r) => {
        const partial = r.failedCount > 0 || (r.deliveredCount > 0 && r.deliveredCount < r.plannedCount);
        return <Badge variant={partial ? "outline" : STATUS_VARIANT[r.status] ?? "muted"} className={partial ? "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300" : undefined}>{partial ? "Partially delivered" : humanise(r.status)}</Badge>;
      },
    },
    {
      key: "stops",
      header: "Stops",
      width: "w-[150px]",
      cell: (r) => (
        <span className="font-mono text-[12px]">
          {r.plannedCount} planned · <span className="text-status-good">{r.deliveredCount}</span> ·{" "}
          <span className="text-status-warn">{r.failedCount}</span>
        </span>
      ),
    },
    {
      key: "cod",
      header: "COD collected / expected",
      align: "right",
      width: "w-[200px]",
      className: "font-mono text-[12px]",
      cell: (r) => (
        <span className={r.codCollectedCents < r.codExpectedCents && r.status === "closed" ? "text-status-bad" : ""}>
          {amount(r.codCollectedCents)} / {amount(r.codExpectedCents)}
        </span>
      ),
    },
  ];

  return (
    <Page
      title="Runsheets"
      description="One rider, one van, one day. Build the run, hand it over, and close it against the cash that comes back."
      actions={
        <>
          <ExportCsvButton<RunsheetRow>
            filename={`natex-runsheets-${colomboToday()}.csv`}
            header={[
              "code",
              "run_date",
              "rider",
              "status",
              "planned",
              "delivered",
              "failed",
              "cod_expected_lkr",
              "cod_collected_lkr",
              "dispatched_at",
              "closed_at",
            ]}
            toRow={(r) => [
              r.code,
              r.runDate,
              r.riderName,
              r.status,
              r.plannedCount,
              r.deliveredCount,
              r.failedCount,
              centsToRupees(r.codExpectedCents),
              centsToRupees(r.codCollectedCents),
              r.dispatchedAt ? dateTime(r.dispatchedAt) : "",
              r.closedAt ? dateTime(r.closedAt) : "",
            ]}
            fetchPage={(p) => client.delivery.runsheetPage({ ...filter, page: p, pageSize: 100 })}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => { setViewCleared((cleared) => !cleared); setOpenId(null); }} title="This only changes the current view; it does not delete Runsheet records.">
            {viewCleared ? <Eye className="size-3.5" /> : <RotateCcw className="size-3.5" />}
            {viewCleared ? "Restore view" : "Clear view"}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            New runsheet
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricTile label="Runs today" value={tally?.runsheetsToday ?? "—"} />
        <MetricTile label="Out now" value={tally?.dispatched ?? "—"} />
        <MetricTile label="Stops planned" value={tally?.stopsPlanned ?? "—"} />
        <MetricTile label="Delivered" value={tally?.delivered ?? "—"} />
        <MetricTile label="Failed" value={tally?.failed ?? "—"} />
        <MetricTile
          label="COD in / expected"
          value={tally ? `${amount(tally.codCollectedCents)}` : "—"}
          hint={tally ? `of ${money(tally.codExpectedCents)}` : undefined}
        />
      </div>

      <DataTable
        columns={columns}
        rows={viewCleared ? [] : list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isPending}
        error={list.isError ? "The runsheet register could not be loaded." : null}
        emptyTitle={viewCleared ? "Runsheet view cleared" : "No runsheets match"}
        emptyDescription={viewCleared ? "Records are preserved. Select Restore view to show them again." :
          statusFilter === "live"
            ? "No run is open or out on the road for this branch. Open one with New runsheet, or switch the filter to All."
            : "Nothing matches these filters for this branch."
        }
        onRowClick={(r) => setOpenId(r.id)}
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? PAGE_SIZE,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <Field label="Search" className="w-[240px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Runsheet code or rider"
                  className="pl-8"
                  aria-label="Search runsheets"
                />
              </div>
            </Field>
            <Field label="Status" className="w-[200px]">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
                <option value="live">Live (draft + on the road)</option>
                <option value="draft">Draft</option>
                <option value="dispatched">On the road</option>
                <option value="closed">Closed</option>
                <option value="cancelled">Cancelled</option>
                <option value="all">All</option>
              </Select>
            </Field>
            <Field label="Run date" className="w-[170px]">
              <Input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
            </Field>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatusFilter("live");
                setRunDate("");
                setSearch("");
              }}
            >
              <RotateCcw aria-hidden />
              Reset
            </Button>
          </>
        }
      />

      <CreateRunsheetDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => {
          setCreating(false);
          setOpenId(id);
        }}
      />
      <RunsheetDrawer runsheetId={openId} canClose={role === "ops" || role === "admin"} onClose={() => setOpenId(null)} />
    </Page>
  );
}

function CreateRunsheetDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const riders = useRiders();
  const [riderId, setRiderId] = React.useState("");
  const [runDate, setRunDate] = React.useState(colomboToday());
  const [localDelivery, setLocalDelivery] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [openWarning, setOpenWarning] = React.useState(false);
  const openRuns = useRiderOpenRunsheets(riderId, runDate);
  const create = useRunsheetCreate({
    onSuccess: (sheet) => {
      setError(null);
      setRiderId("");
      onCreated(sheet.id);
    },
    onError: setError,
  });

  const submitCreate = () => {
    setError(null);
    if ((openRuns.data?.rows.length ?? 0) > 0) {
      setOpenWarning(true);
      return;
    }
    create.mutate({ riderId, runDate, localDelivery });
  };

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Open a runsheet"
      description="Create a separate route and cash record for this rider."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button pending={create.isPending} disabled={!riderId || openRuns.isPending} onClick={submitCreate}>
            Open as draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="Rider" hint="Active riders rostered at your branch.">
          <Select value={riderId} onChange={(e) => setRiderId(e.target.value)} aria-label="Rider">
            <option value="">{riders.isPending ? "Loading riders…" : "Choose a rider"}</option>
            {(riders.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.phone}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Run date">
          <Input type="date" value={runDate} onChange={(e) => setRunDate(e.target.value)} />
        </Field>
        <label className="flex items-start gap-2 rounded-md border border-brand/30 bg-brand/5 px-3 py-2 text-[13px]">
          <input type="checkbox" checked={localDelivery} onChange={(e) => setLocalDelivery(e.target.checked)} />
          <span><strong>Local delivery</strong><span className="block text-[12px] text-muted-foreground">Only parcels whose destination address is in this hub district can be added. The normal same-district rate card remains authoritative.</span></span>
        </label>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Dialog>
    <Dialog
      open={openWarning}
      onOpenChange={setOpenWarning}
      title="Rider already has an open runsheet"
      description="You can still create another runsheet, but keep the rider's parcels and cash clearly separated."
      className="w-[560px]"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpenWarning(false)} disabled={create.isPending}>Cancel</Button>
          <Button
            pending={create.isPending}
            onClick={() => {
              setOpenWarning(false);
              create.mutate({ riderId, runDate, localDelivery });
            }}
          >
            Create another draft
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p className="leading-relaxed text-muted-foreground">
          {openRuns.data?.rows.length === 1 ? "This rider has one" : `This rider has ${openRuns.data?.rows.length ?? 0}`} open runsheet{openRuns.data?.rows.length === 1 ? "" : "s"} for {date(runDate)}:
        </p>
        <ul className="space-y-2">
          {(openRuns.data?.rows ?? []).map((run) => (
            <li key={run.id} className="flex items-center justify-between gap-3 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2 dark:border-sky-900 dark:bg-sky-950/20">
              <span className="font-mono font-medium">{run.code}</span>
              <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                <Badge variant={run.status === "dispatched" ? "warn" : "muted"}>{humanise(run.status)}</Badge>
                {run.plannedCount} stop{run.plannedCount === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
        <p className="rounded-md border border-amber-300/70 bg-amber-50 px-3 py-2 text-amber-950">
          Multiple runsheets are allowed. Confirm only if this is intentional, because each sheet has its own route and cash record.
        </p>
      </div>
    </Dialog>
    </>
  );
}

function RunsheetDrawer({
  runsheetId,
  canClose,
  onClose,
}: {
  runsheetId: string | null;
  canClose: boolean;
  onClose: () => void;
}) {
  const detail = useRunsheet(runsheetId);
  const data = detail.data;
  const sheet = data?.runsheet;

  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<null | "dispatch" | "close" | "cancel" | { remove: string }>(null);
  const [awbText, setAwbText] = React.useState("");
  const [addLines, setAddLines] = React.useState<DeliveryOut<"runsheetAdd">["lines"]>([]);
  const [dispatchReview, setDispatchReview] = React.useState<DeliveryOut<"runsheetDispatchReview"> | null>(null);
  const [dispatchOutcome, setDispatchOutcome] = React.useState<DeliveryOut<"runsheetDispatch"> | null>(null);
  const [reviewingDispatch, setReviewingDispatch] = React.useState(false);
  const [force, setForce] = React.useState(false);
  const [closeNotes, setCloseNotes] = React.useState("");
  const [cancelReason, setCancelReason] = React.useState("");
  // Frozen when the confirm opens: the refetch after a force-close empties the
  // pending list while the dialog is still fading out, and the title must not
  // flip under the user (or a screen reader) mid-animation.
  const [closeWritesOff, setCloseWritesOff] = React.useState(0);

  React.useEffect(() => {
    setError(null);
    setDone(null);
    setConfirm(null);
    setAwbText("");
    setAddLines([]);
    setDispatchReview(null);
    setDispatchOutcome(null);
    setReviewingDispatch(false);
    setForce(false);
    setCloseNotes("");
    setCancelReason("");
  }, [runsheetId]);

  const isDraft = sheet?.status === "draft";
  const isDispatched = sheet?.status === "dispatched";
  const canAddStops = isDraft || isDispatched;
  const stock = useDeliverable(Boolean(isDraft));

  const fail = (message: string) => {
    setError(message);
    setDone(null);
  };
  const add = useRunsheetAdd({
    onSuccess: (r) => {
      setAddLines(r.lines);
      setAwbText("");
      setError(null);
      setDone(
        r.added === 0
          ? "No stops were added. Review the result beside each tracking number."
          : `${r.added} stop${r.added === 1 ? "" : "s"} added${isDispatched ? " to the end of the active route and marked Out for Delivery" : " to the draft"}.`,
      );
    },
    onError: fail,
  });
  const remove = useRunsheetRemove({
    onSuccess: () => {
      setConfirm(null);
      setError(null);
      setDone("Stop taken off the run.");
    },
    onError: (m) => {
      setConfirm(null);
      fail(m);
    },
  });
  const optimise = useRunsheetOptimise({
    onSuccess: (r) => {
      setError(null);
      setDone(
        `Ordered by ${humanise(r.method)} — ${(r.totalMetres / 1000).toFixed(1)} km${
          r.unlocated.length ? `, ${r.unlocated.length} stop(s) without coordinates appended at the end` : ""
        }.`,
      );
    },
    onError: fail,
  });
  const dispatch = useRunsheetDispatch({
    onSuccess: (r) => {
      setConfirm(null);
      setDispatchReview(null);
      setDispatchOutcome(r);
      if (r.dispatchBlock) {
        fail(r.dispatchBlock.reason);
      } else {
        setError(null);
        setDone(
          r.movedOut.length === 0
            ? "Nothing was dispatched. The draft is still open; correct the listed stops and review again."
            : `${r.movedOut.length} parcel(s) sent to the rider${r.rejected.length ? `; ${r.rejected.length} held out for correction` : ""}${r.notificationWarnings.length ? `; ${r.notificationWarnings.length} delivery notice(s) need review` : ""}.`,
        );
      }
    },
    onError: (m) => {
      setConfirm(null);
      setDispatchReview(null);
      fail(m);
    },
  });
  const close = useRunsheetClose({
    onSuccess: (r) => {
      setConfirm(null);
      setError(null);
      setDone(
        `Closed. ${r.unattempted.length ? `${r.unattempted.length} stop(s) written off as ran out of time (no attempt burned). ` : ""}Cash variance ${money(r.cash.varianceCents)}.`,
      );
    },
    onError: (m) => {
      setConfirm(null);
      fail(m);
    },
  });

  const cancel = useRunsheetCancel({
    onSuccess: (r) => {
      setConfirm(null);
      setError(null);
      setCancelReason("");
      setDone(
        `Cancelled. ${r.released.length} stop(s) went back to ready stock; ${r.runsheet.riderName} is free for a new run today.`,
      );
    },
    onError: (m) => {
      setConfirm(null);
      fail(m);
    },
  });

  const pendingStops = (data?.items ?? []).filter((i) => i.state === "pending");
  const liveStops = (data?.items ?? []).filter((i) => i.state !== "removed");
  const awbs = awbText
    .split(/[\s,;]+/)
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);
  const closeBlocked =
    pendingStops.length > 0 ? !force || closeNotes.trim().length < 10 : false;

  const reviewDispatch = async () => {
    if (!sheet) return;
    setError(null);
    setDone(null);
    setDispatchOutcome(null);
    setReviewingDispatch(true);
    try {
      const review = await client.delivery.runsheetDispatchReview({ runsheetId: sheet.id });
      setDispatchReview(review);
      setConfirm("dispatch");
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : "Could not review the runsheet. Refresh and try again.");
    } finally {
      setReviewingDispatch(false);
    }
  };

  return (
    <Drawer
      open={Boolean(runsheetId)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={sheet ? sheet.code : "Runsheet"}
      subtitle={sheet ? `${sheet.riderName} · ${date(sheet.runDate)}` : undefined}
    >
      {detail.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading the run…</p>
      ) : detail.isError ? (
        <ErrorNote>That runsheet could not be read. It may belong to another branch.</ErrorNote>
      ) : !sheet || !data ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const partial = sheet.failedCount > 0 || (sheet.deliveredCount > 0 && sheet.deliveredCount < sheet.plannedCount);
              return <Badge variant={partial ? "outline" : STATUS_VARIANT[sheet.status] ?? "muted"} className={partial ? "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300" : undefined}>{partial ? "Partially delivered" : humanise(sheet.status)}</Badge>;
            })()}
            {sheet.routeMethod ? <Badge variant="muted">route: {humanise(sheet.routeMethod)}</Badge> : null}
          </div>

          <KeyValueGrid>
            <KeyValue label="Hub">{data.hubName ?? sheet.hubId}</KeyValue>
            <KeyValue label="Rider">{sheet.riderName}</KeyValue>
            <KeyValue label="Stops">{`${sheet.plannedCount} planned · ${sheet.deliveredCount} delivered · ${sheet.failedCount} failed`}</KeyValue>
            <KeyValue label="Opened by">{sheet.createdByName ?? "—"}</KeyValue>
            <KeyValue label="Dispatched" mono>
              {sheet.dispatchedAt ? dateTime(sheet.dispatchedAt) : "—"}
            </KeyValue>
            <KeyValue label="Closed" mono>
              {sheet.closedAt ? dateTime(sheet.closedAt) : "—"}
            </KeyValue>
          </KeyValueGrid>

          <section className="grid grid-cols-3 gap-2 rounded-md border p-3">
            <CashCell label="COD expected" cents={data.cash.expectedCents} />
            <CashCell label="Collected" cents={data.cash.collectedCents} />
            <CashCell
              label="Outstanding"
              cents={data.cash.outstandingCents}
              tone={data.cash.outstandingCents > 0 && sheet.status === "closed" ? "bad" : undefined}
            />
          </section>

          <section className="space-y-1.5">
            <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Stops ({liveStops.length})
            </h4>
            {liveStops.length === 0 ? (
              <p className="rounded-md border border-dashed p-3 text-[13px] text-muted-foreground">
                No stops yet. Scan or paste tracking numbers below.
              </p>
            ) : (
              <ol className="divide-y rounded-md border">
                {liveStops.map((stop) => (
                  <StopLine
                    key={stop.id}
                    stop={stop}
                    removable={isDraft}
                    onRemove={() => setConfirm({ remove: stop.awb })}
                  />
                ))}
              </ol>
            )}
          </section>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}
          {dispatchOutcome && (dispatchOutcome.rejected.length > 0 || dispatchOutcome.dispatchBlock || dispatchOutcome.notificationWarnings.length > 0) ? (
            <section className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-950" role="status">
              <h4 className="font-semibold">
                {dispatchOutcome.movedOut.length > 0 ? "Held out of the rider's run" : "Dispatch stopped — correct before retrying"}
              </h4>
              {dispatchOutcome.dispatchBlock ? (
                <div>
                  <p>{dispatchOutcome.dispatchBlock.reason}</p>
                  <p className="mt-1"><strong>Next step:</strong> {dispatchOutcome.dispatchBlock.correction}</p>
                </div>
              ) : null}
              {dispatchOutcome.rejected.map((item) => (
                <div key={item.awb} className="border-t border-amber-300/70 pt-2">
                  <p><span className="font-mono font-semibold">{item.awb}</span> · {humanise(item.status)} — {item.reason}</p>
                  <p className="mt-1"><strong>Next step:</strong> {item.correction}</p>
                </div>
              ))}
              {dispatchOutcome.notificationWarnings.map((item) => (
                <p key={item.awb} className="border-t border-amber-300/70 pt-2">
                  <span className="font-mono font-semibold">{item.awb}</span>: delivery status moved, but its notification needs review — {item.reason}
                </p>
              ))}
            </section>
          ) : null}

          {canAddStops ? (
            <section className="space-y-3 border-t pt-4">
              {isDispatched ? (
                <p className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-[13px] leading-relaxed text-sky-900">
                  Appended parcels go after the existing stops and are marked Out for Delivery immediately. The current stop order is preserved.
                </p>
              ) : null}
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (awbs.length === 0) return;
                  setError(null);
                  add.mutate({ runsheetId: sheet.id, awbs: awbs.slice(0, 200) });
                }}
              >
                <Field
                  label={isDispatched ? "Append stops to active route" : "Add stops"}
                  hint="Scan or paste tracking numbers, one per line. Each gets its own verdict — a stray label never fails the batch."
                >
                  <Textarea
                    value={awbText}
                    onChange={(e) => setAwbText(e.target.value)}
                    rows={3}
                    className="font-mono text-[12px]"
                    placeholder="NX1234567890"
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" pending={add.isPending} disabled={awbs.length === 0}>
                    {isDispatched ? "Append" : "Add"} {awbs.length || ""} stop{awbs.length === 1 ? "" : "s"}
                  </Button>
                  {isDraft ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!stock.data || stock.data.ready.length === 0}
                      onClick={() => setAwbText(stock.data!.ready.map((p) => p.awb).join("\n"))}
                    >
                      Fill from ready stock ({stock.data?.ready.length ?? 0})
                    </Button>
                  ) : null}
                </div>
              </form>
              {addLines.length > 0 ? (
                <ul className="space-y-2 text-[12px]">
                  {addLines.map((l) => (
                    <li key={l.awb} className="rounded-md border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono">{l.awb}</span>
                        <Badge variant={l.verdict === "added" ? "good" : l.verdict === "duplicate" ? "muted" : "bad"}>
                          {l.verdict}
                        </Badge>
                      </div>
                      {l.reason ? <p className="mt-1 text-muted-foreground">{l.reason}</p> : null}
                      {l.correction ? <p className="mt-1 text-foreground"><strong>Next step:</strong> {l.correction}</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {isDraft ? (
                <>
                  <div className="flex flex-wrap gap-2 border-t pt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      pending={optimise.isPending}
                      disabled={liveStops.length < 2}
                      onClick={() => optimise.mutate({ runsheetId: sheet.id })}
                    >
                      <Route aria-hidden />
                      Order the stops
                    </Button>
                    <Button size="sm" pending={reviewingDispatch} disabled={pendingStops.length === 0} onClick={() => void reviewDispatch()}>
                      <Send aria-hidden />
                      Review & dispatch
                    </Button>
                  </div>
                  <div className="space-y-2 border-t pt-3">
                <Field
                  label="Cancel this draft"
                  hint="Nothing has left the hub, so no parcel moves. The reason is recorded in the audit log — at least 5 characters."
                >
                  <Input
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                    placeholder="Van failed its morning check"
                    aria-label="Reason for cancelling the draft"
                  />
                </Field>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={cancelReason.trim().length < 5}
                  onClick={() => setConfirm("cancel")}
                >
                  <Ban aria-hidden />
                  Cancel the draft
                </Button>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {sheet.status === "dispatched" && canClose ? (
            <section className="space-y-3 border-t pt-4">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {pendingStops.length === 0 && sheet.failedCount > 0 ? "Partially delivered run" : "End of day"}
              </h4>
              {pendingStops.length > 0 ? (
                <>
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
                    {pendingStops.length} stop(s) have no outcome yet. Closing now writes them off as
                    "ran out of time" — NatEx's failure, so the consignee's attempt is not burned.
                  </p>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      aria-label="Write off the open stops and close"
                      checked={force}
                      onChange={(e) => setForce(e.target.checked)}
                      className="size-4 accent-[var(--color-brand)]"
                    />
                    Write off the open stops and close
                  </label>
                </>
              ) : null}
              {pendingStops.length === 0 && sheet.failedCount > 0 ? (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  All stops have an outcome, but {sheet.failedCount} stop(s) were not delivered. Close this run to keep it recorded as partially delivered.
                </p>
              ) : null}
              <Field
                label="Notes"
                hint={pendingStops.length > 0 ? "Required when writing stops off — at least 10 characters." : "Optional."}
              >
                <Textarea
                  value={closeNotes}
                  onChange={(e) => setCloseNotes(e.target.value)}
                  rows={2}
                  placeholder="Heavy rain from 15:00, rider back at hub 18:20."
                />
              </Field>
              <Button size="sm" variant={pendingStops.length > 0 ? "destructive" : "default"} disabled={closeBlocked} onClick={() => {
                  setCloseWritesOff(pendingStops.length);
                  setConfirm("close");
              }}>
                <Lock aria-hidden />
                {pendingStops.length === 0 && sheet.failedCount > 0 ? "Close as partially delivered" : "Close the run"}
              </Button>
            </section>
          ) : null}

          <Dialog
            open={confirm === "dispatch" && dispatchReview !== null}
            onOpenChange={(open) => {
              if (!open) {
                setConfirm(null);
                setDispatchReview(null);
              }
            }}
            title="Review the run before dispatch"
            description={dispatchReview ? `${dispatchReview.runsheet.code} · ${dispatchReview.runsheet.riderName}` : undefined}
            footer={dispatchReview ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" disabled={dispatch.isPending} onClick={() => { setConfirm(null); setDispatchReview(null); }}>
                  Back and correct
                </Button>
                <Button
                  pending={dispatch.isPending}
                  disabled={dispatchReview.ready.length === 0 || dispatchReview.dispatchBlock !== null}
                  onClick={() => dispatch.mutate({ runsheetId: sheet.id })}
                >
                  {dispatchReview.ready.length > 0
                    ? `Dispatch ${dispatchReview.ready.length} ready stop(s)`
                    : "No ready stops"}
                </Button>
              </div>
            ) : null}
          >
            {dispatchReview ? (
              <div className="space-y-3 text-[13px]">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-emerald-950">
                    <p className="font-semibold">Ready</p>
                    <p>{dispatchReview.ready.length} stop(s) can be sent.</p>
                  </div>
                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950">
                    <p className="font-semibold">Held out</p>
                    <p>{dispatchReview.blocked.length} stop(s) need correction.</p>
                  </div>
                </div>
                {dispatchReview.dispatchBlock ? (
                  <div className="rounded-md border border-status-bad/40 bg-status-bad/5 p-3 text-status-bad" role="alert">
                    <p className="font-semibold">The rider cannot receive another run yet.</p>
                    <p className="mt-1">{dispatchReview.dispatchBlock.reason}</p>
                    <p className="mt-1"><strong>Next step:</strong> {dispatchReview.dispatchBlock.correction}</p>
                  </div>
                ) : null}
                {dispatchReview.ready.length > 0 ? (
                  <section className="rounded-md border border-emerald-300 p-3">
                    <h4 className="font-semibold text-emerald-900">Ready stops — these will go to the rider</h4>
                    <ul className="mt-2 space-y-1">
                      {dispatchReview.ready.map((item) => (
                        <li key={item.awb} className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-medium">{item.awb}</span>
                          <Badge variant="good">Ready</Badge>
                          <span className="text-muted-foreground">{humanise(item.status)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {dispatchReview.blocked.length > 0 ? (
                  <ul className="space-y-2">
                    {dispatchReview.blocked.map((item) => (
                      <li key={item.awb} className="rounded-md border border-amber-300 p-3">
                        <p><span className="font-mono font-semibold">{item.awb}</span> · {humanise(item.status)}</p>
                        <p className="mt-1 text-muted-foreground">{item.reason}</p>
                        <p className="mt-1"><strong>Next step:</strong> {item.correction}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-md border border-emerald-300 p-3 text-emerald-900">All stops passed the branch, parcel-status and retry checks.</p>
                )}
                <p className="text-muted-foreground">
                  Only ready stops will be handed to the rider. Held stops are kept off the route; if none are ready, the draft remains open and nothing is dispatched.
                </p>
              </div>
            ) : null}
          </Dialog>
          <ConfirmDialog
            open={confirm === "cancel"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Cancel this draft run?"
            objectName={sheet.code}
            confirmLabel="Cancel the draft"
            pending={cancel.isPending}
            body={`${liveStops.length} stop(s) go back to the hub's ready stock and ${sheet.riderName} can be given a new run today. A cancelled run is never reopened.`}
            onConfirm={() => cancel.mutate({ runsheetId: sheet.id, reason: cancelReason.trim() })}
          />
          <ConfirmDialog
            open={confirm === "close"}
            onOpenChange={(o) => !o && setConfirm(null)}
            title={closeWritesOff > 0 ? "Force-close this run?" : sheet.failedCount > 0 ? "Close as partially delivered?" : "Close this run?"}
            objectName={sheet.code}
            confirmLabel="Close the run"
            pending={close.isPending}
            body={
              closeWritesOff > 0
                ? `${closeWritesOff} stop(s) will be written off as ran out of time and go back to stock. The rider's cash position is fixed at ${money(sheet.codCollectedCents)} collected of ${money(sheet.codExpectedCents)}.`
                : `${sheet.failedCount > 0 ? "The run will remain recorded as partially delivered. " : ""}The rider's cash position is fixed at ${money(sheet.codCollectedCents)} collected of ${money(sheet.codExpectedCents)}. A closed run is never reopened.`
            }
            onConfirm={() =>
              close.mutate({
                runsheetId: sheet.id,
                force: pendingStops.length > 0 ? force : false,
                notes: closeNotes.trim() || null,
              })
            }
          />
          <ConfirmDialog
            open={typeof confirm === "object" && confirm !== null}
            onOpenChange={(o) => !o && setConfirm(null)}
            title="Take this stop off the run?"
            objectName={typeof confirm === "object" && confirm ? confirm.remove : ""}
            confirmLabel="Remove stop"
            pending={remove.isPending}
            body="The parcel goes back to the hub's ready stock. The removal is recorded on the run."
            onConfirm={() =>
              typeof confirm === "object" && confirm
                ? remove.mutate({ runsheetId: sheet.id, awb: confirm.remove, reason: "Removed at the ops desk before dispatch" })
                : undefined
            }
          />
        </div>
      )}
    </Drawer>
  );
}

function CashCell({ label, cents, tone }: { label: string; cents: number; tone?: "bad" }) {
  return (
    <div>
      <p className="label-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-[15px] ${tone === "bad" ? "text-status-bad" : ""}`}>{money(cents)}</p>
    </div>
  );
}

function StopLine({ stop, removable, onRemove }: { stop: Stop; removable: boolean; onRemove: () => void }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[12px] text-muted-foreground">{stop.seq}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12px]">{stop.awb}</span>
          <Badge variant={STOP_VARIANT[stop.state] ?? "muted"}>{humanise(stop.state)}</Badge>
          {stop.status ? <StatusPill status={stop.status} /> : null}
        </div>
        <p className="truncate text-[12px] text-muted-foreground">
          {stop.consigneeName} · {stop.destAddress}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {stop.codAmountCents > 0 ? `COD ${money(stop.codAmountCents)}` : "Prepaid"}
          {stop.podPolicy ? ` · POD ${stop.podPolicy}` : ""}
        </p>
      </div>
      {removable ? (
        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${stop.awb}`} onClick={onRemove}>
          <Trash2 aria-hidden />
        </Button>
      ) : null}
    </li>
  );
}
