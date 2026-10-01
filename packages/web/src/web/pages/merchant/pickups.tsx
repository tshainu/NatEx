import * as React from "react";
import { Plus, Search } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { apiDetails, apiMessage, client } from "@/lib/api";
import { colomboToday, date, dateTime, humanise } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { Page, ErrorNote, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";
import { MetricTile } from "@/components/natex/metric-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  useBookedParcels,
  useCancelPickup,
  usePickupCounts,
  usePickupRequests,
  useRequestPickup,
  type PickupRequestRow,
  type PickupStatus,
} from "@/queries/merchant";

/**
 * /merchant/pickups — "come and collect these Booked parcels on this date".
 *
 * A request is the merchant's half; NatEx operations answers it by building a
 * pickup manifest for a rider, at which point it reads `scheduled` with the
 * manifest code. Only a `requested` pickup can be cancelled here — once a rider
 * is assigned the server refuses (409) and the merchant must call ops.
 */

const PAGE_SIZE = 25;
const HORIZON_DAYS = 14;

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

const STATUS_BADGE: Record<PickupStatus, "brand" | "good" | "muted"> = {
  requested: "brand",
  scheduled: "good",
  cancelled: "muted",
};

export default function MerchantPickups() {
  const [status, setStatus] = React.useState<PickupStatus | "">("");
  const [page, setPage] = React.useState(1);
  const [creating, setCreating] = React.useState(false);
  const [cancelling, setCancelling] = React.useState<PickupRequestRow | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const filter = { page, pageSize: PAGE_SIZE, status: status ? [status] : undefined };
  const list = usePickupRequests(filter);
  const counts = usePickupCounts();

  const pick = (s: PickupStatus | "") => {
    setStatus((cur) => (cur === s ? "" : s));
    setPage(1);
  };

  const columns: Column<PickupRequestRow>[] = [
    { key: "code", header: "Request", width: "w-[150px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    {
      key: "date",
      header: "Pickup",
      width: "w-[170px]",
      cell: (r) => (
        <span>
          <span className="font-mono">{r.pickupDate}</span>{" "}
          <span className="text-muted-foreground">{humanise(r.window)}</span>
        </span>
      ),
    },
    { key: "count", header: "Parcels", align: "right", width: "w-[80px]", className: "font-mono", cell: (r) => r.parcelCount },
    {
      key: "status",
      header: "Status",
      width: "w-[120px]",
      cell: (r) => <Badge variant={STATUS_BADGE[r.status as PickupStatus]}>{humanise(r.status)}</Badge>,
    },
    {
      key: "manifest",
      header: "Rider manifest",
      width: "w-[150px]",
      cell: (r) => (r.manifestCode ? <MonoCell>{r.manifestCode}</MonoCell> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: "notes",
      header: "Notes",
      cell: (r) => (
        <span className="truncate text-muted-foreground">
          {r.status === "cancelled" ? `Cancelled: ${r.cancelReason ?? ""}` : (r.notes ?? "—")}
        </span>
      ),
    },
    {
      key: "created",
      header: "Requested",
      align: "right",
      width: "w-[150px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => dateTime(r.createdAt),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "w-[100px]",
      cell: (r) =>
        r.status === "requested" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setCancelling(r);
            }}
          >
            Cancel
          </Button>
        ) : null,
    },
  ];

  return (
    <Page
      title="Pickups"
      description="Tell NatEx which booked parcels to collect and when. Operations assigns a rider and the request shows the rider's manifest."
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus aria-hidden />
          Request pickup
        </Button>
      }
      bleed
    >
      {notice ? <SuccessNote>{notice}</SuccessNote> : null}
      <div className="grid grid-cols-3 gap-4">
        <MetricTile label="Awaiting NatEx" value={counts.data?.requested ?? "—"} onClick={() => pick("requested")} active={status === "requested"} />
        <MetricTile label="Scheduled" value={counts.data?.scheduled ?? "—"} onClick={() => pick("scheduled")} active={status === "scheduled"} />
        <MetricTile label="Cancelled" value={counts.data?.cancelled ?? "—"} onClick={() => pick("cancelled")} active={status === "cancelled"} />
      </div>
      <DataTable
        columns={columns}
        rows={list.data?.rows ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "Your pickup requests are unavailable.") : null}
        emptyTitle={status ? `No ${status} pickups` : "No pickup requests yet"}
        emptyDescription="Book parcels first, then request a pickup naming them."
        filters={
          <>
            <Field label="Status" className="w-48">
              <Select value={status} onChange={(e) => pick(e.target.value as PickupStatus | "")}>
                <option value="">All statuses</option>
                <option value="requested">Requested</option>
                <option value="scheduled">Scheduled</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </Field>
            <div className="ml-auto self-end">
              <ExportCsvButton<PickupRequestRow>
                filename={`pickups-${colomboToday()}.csv`}
                header={["code", "pickup_date", "window", "parcels", "status", "manifest", "awbs", "notes", "requested_at"]}
                toRow={(r) => [r.code, r.pickupDate, r.window, r.parcelCount, r.status, r.manifestCode ?? "", r.awbs.join(" "), r.notes ?? r.cancelReason ?? "", new Date(r.createdAt).toISOString()]}
                fetchPage={(p) => client.collection.pickupRequests({ ...filter, page: p, pageSize: 100 })}
              />
            </div>
          </>
        }
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? PAGE_SIZE,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />

      <RequestPickupDialog
        open={creating}
        onOpenChange={setCreating}
        onDone={(code, n) => {
          setNotice(`Pickup ${code} requested for ${n} parcel${n === 1 ? "" : "s"}.`);
          setCreating(false);
        }}
      />
      <CancelPickupDialog
        request={cancelling}
        onClose={() => setCancelling(null)}
        onDone={(code) => {
          setNotice(`Pickup ${code} cancelled. Its parcels can go on a new request.`);
          setCancelling(null);
        }}
      />
    </Page>
  );
}

function RequestPickupDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (code: string, count: number) => void;
}) {
  const merchantId = useAuth().session!.user.merchantId;
  const today = colomboToday();
  const [pickupDate, setPickupDate] = React.useState(() => addDays(today, 1));
  const [slot, setSlot] = React.useState<"morning" | "afternoon">("morning");
  const [notes, setNotes] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const [problems, setProblems] = React.useState<{ awb: string; reason: string }[]>([]);
  const debounced = useDebounced(search, 250);
  const booked = useBookedParcels(debounced);
  const request = useRequestPickup();

  const rows = booked.data?.rows ?? [];
  const toggle = (awb: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(awb)) n.delete(awb);
      else n.add(awb);
      return n;
    });
  const allShown = rows.length > 0 && rows.every((r) => selected.has(r.awb));

  const submit = () => {
    setError(null);
    setProblems([]);
    if (!merchantId) return setError("This login is not linked to a merchant account.");
    if (selected.size === 0) return setError("Tick at least one parcel for the rider to collect.");
    request.mutate(
      { merchantId, pickupDate, window: slot, awbs: [...selected], notes: notes.trim() || null },
      {
        onSuccess: (r) => {
          setSelected(new Set());
          setNotes("");
          onDone(r.code, r.parcelCount);
        },
        onError: (err) => {
          setError(apiMessage(err, "The pickup could not be requested."));
          const p = apiDetails(err).problems;
          if (Array.isArray(p)) setProblems(p as { awb: string; reason: string }[]);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Request a pickup"
      description={`A rider collects from your address on file. Up to ${HORIZON_DAYS} days ahead.`}
      className="w-[620px]"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-muted-foreground">{selected.size} selected</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={request.isPending}>
              Close
            </Button>
            <Button onClick={submit} pending={request.isPending} disabled={selected.size === 0}>
              Request pickup
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pickup date">
            <Input
              type="date"
              value={pickupDate}
              min={today}
              max={addDays(today, HORIZON_DAYS)}
              onChange={(e) => setPickupDate(e.target.value)}
            />
          </Field>
          <Field label="Window">
            <Select value={slot} onChange={(e) => setSlot(e.target.value as "morning" | "afternoon")}>
              <option value="morning">Morning (9–12)</option>
              <option value="afternoon">Afternoon (1–5)</option>
            </Select>
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="label-xs text-muted-foreground">Booked parcels</legend>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by AWB, consignee or phone"
              aria-label="Filter booked parcels"
              className="pl-8 font-mono text-[13px]"
            />
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {booked.isLoading ? (
              <p className="p-3 text-[13px] text-muted-foreground">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="p-3 text-[13px] text-muted-foreground">
                No parcels at Booked{debounced ? " match this filter" : ""}. Book parcels first.
              </p>
            ) : (
              <ul>
                <li className="border-b bg-muted/40 px-3 py-1.5">
                  <label className="flex items-center gap-2 text-[12px] font-medium">
                    <input
                      type="checkbox"
                      aria-label={allShown ? "Clear all shown" : "Select all shown"}
                      checked={allShown}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          for (const r of rows) {
                            if (allShown) n.delete(r.awb);
                            else n.add(r.awb);
                          }
                          return n;
                        })
                      }
                    />
                    {allShown ? "Clear" : "Select"} all {rows.length} shown
                    {booked.data && booked.data.total > rows.length ? ` (of ${booked.data.total})` : ""}
                  </label>
                </li>
                {rows.map((r) => {
                  const problem = problems.find((p) => p.awb === r.awb);
                  return (
                    <li key={r.id} className="border-b last:border-b-0">
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-[13px] hover:bg-accent">
                        <input type="checkbox" aria-label={`Select ${r.awb}`} checked={selected.has(r.awb)} onChange={() => toggle(r.awb)} />
                        <span className="w-32 font-mono">{r.awb}</span>
                        <span className="min-w-0 flex-1 truncate">{r.consigneeName}</span>
                        <span className="text-[11px] text-muted-foreground">{date(r.createdAt)}</span>
                        {problem ? <span className="text-[11px] text-status-bad">{problem.reason}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </fieldset>

        <Field label="Notes for the rider" hint="Optional — gate code, contact on site">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {problems.length ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelected((s) => {
                const n = new Set(s);
                for (const p of problems) n.delete(p.awb);
                return n;
              });
              setProblems([]);
              setError(null);
            }}
          >
            Untick the {problems.length} parcel{problems.length === 1 ? "" : "s"} that cannot go
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}

function CancelPickupDialog({
  request,
  onClose,
  onDone,
}: {
  request: PickupRequestRow | null;
  onClose: () => void;
  onDone: (code: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const cancel = useCancelPickup();

  return (
    <ConfirmDialog
      open={request !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason("");
          setError(null);
          onClose();
        }
      }}
      title="Cancel this pickup?"
      objectName={request ? `${request.code} · ${request.parcelCount} parcel(s) on ${request.pickupDate}` : ""}
      confirmLabel="Cancel pickup"
      pending={cancel.isPending}
      body={
        <div className="space-y-3">
          <p>No rider will come. The parcels stay Booked and can go on a new request.</p>
          <Field label="Reason" hint="At least 5 characters — kept on the audit trail">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      }
      onConfirm={() => {
        if (!request) return;
        if (reason.trim().length < 5) {
          setError("Give a reason of at least 5 characters.");
          return;
        }
        cancel.mutate(
          { id: request.id, reason: reason.trim() },
          {
            onSuccess: () => {
              setReason("");
              setError(null);
              onDone(request.code);
            },
            onError: (err) => setError(apiMessage(err, "The pickup could not be cancelled.")),
          },
        );
      }}
    />
  );
}
