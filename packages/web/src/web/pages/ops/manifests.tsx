import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { orpc, apiMessage, apiDetails } from "@/lib/api";
import { date, dateTime, colomboToday, amount, humanise } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Page, KeyValue, KeyValueGrid, ErrorNote, SuccessNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { useAuth } from "@/components/auth-provider";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { usePickupCounts, usePickupRequests, type PickupRequestRow } from "@/queries/merchant";

/**
 * Pickup manifests (§5 collection). A manifest is one merchant, one rider, one
 * date. Ops builds it from the AWBs the merchant declared; the rider scans at
 * the counter; custody moves once, at handover.
 *
 * The second tab is the merchants' side of that loop: pickup requests waiting
 * for a rider. "Schedule" opens the same create dialog pre-filled from the
 * request and sends `pickupRequestId`, so the server marks the request
 * scheduled and links it to the manifest in the same call.
 */

interface ManifestRow {
  id: string;
  code: string;
  merchantId: string;
  merchantName: string;
  riderId: string | null;
  assignmentSource: string;
  pickupDate: string;
  status: string;
  expectedCount: number;
  scannedCount: number;
  handedOverAt: string | Date | null;
  createdAt: string | Date;
}

const MANIFEST_STATE: Record<string, { label: string; variant: "muted" | "brand" | "good" | "warn" }> = {
  assigned: { label: "Assigned", variant: "muted" },
  in_progress: { label: "Scanning", variant: "brand" },
  handed_over: { label: "Handed over", variant: "good" },
  cancelled: { label: "Cancelled", variant: "warn" },
};

function ManifestState({ status }: { status: string }) {
  const state = MANIFEST_STATE[status] ?? { label: humanise(status), variant: "muted" as const };
  return <Badge variant={state.variant}>{state.label}</Badge>;
}

export default function OpsManifests() {
  const { session } = useAuth();
  const role = session!.user.role;
  const canWrite = role === "ops" || role === "admin";

  const [page, setPage] = React.useState(1);
  const [pickupDate, setPickupDate] = React.useState("");
  const [riderId, setRiderId] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [answering, setAnswering] = React.useState<ManifestPrefill | null>(null);
  const [tab, setTab] = useTabParam("tab", ["manifests", "requests"] as const, "manifests");
  const pickupCounts = usePickupCounts();

  React.useEffect(() => setPage(1), [pickupDate, riderId]);

  const riders = useQuery({
    ...orpc.identity.listRiders.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const list = useQuery(
    orpc.collection.list.queryOptions({
      input: {
        page,
        pageSize: 25,
        pickupDate: pickupDate || undefined,
        riderId: riderId || undefined,
      },
    }),
  );

  const riderName = React.useCallback(
    (id: string | null) =>
      id ? (riders.data?.find((r) => r.id === id)?.name ?? id) : "Unassigned",
    [riders.data],
  );

  const columns: Column<ManifestRow>[] = [
    {
      key: "code",
      header: "Manifest",
      width: "w-[150px]",
      cell: (r) => <MonoCell>{r.code}</MonoCell>,
    },
    { key: "state", header: "State", width: "w-[130px]", cell: (r) => <ManifestState status={r.status} /> },
    { key: "assignment", header: "Allocation", width: "w-[150px]", cell: (r) => <Badge variant={r.assignmentSource === "merchant_default" ? "brand" : "muted"}>{r.assignmentSource === "merchant_default" ? "Auto-assigned" : "Manual"}</Badge> },
    { key: "merchant", header: "Merchant", cell: (r) => <span className="truncate">{r.merchantName}</span> },
    {
      key: "rider",
      header: "Rider",
      width: "w-[170px]",
      cell: (r) => (
        <span className="truncate text-muted-foreground">{riderName(r.riderId)}</span>
      ),
    },
    {
      key: "progress",
      header: "Scanned",
      align: "right",
      width: "w-[110px]",
      className: "font-mono",
      cell: (r) => (
        <span className={r.scannedCount < r.expectedCount ? "text-status-warn" : ""}>
          {r.scannedCount}/{r.expectedCount}
        </span>
      ),
    },
    {
      key: "pickupDate",
      header: "Pickup date",
      align: "right",
      width: "w-[120px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.pickupDate),
    },
  ];

  return (
    <Page
      title="Pickup manifests"
      description="One merchant, one rider, one date. Scanning records presence; custody only moves at handover, so a declared-but-unscanned parcel stays Booked and is reported as a shortfall."
      actions={
        canWrite ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            New manifest
          </Button>
        ) : null
      }
      bleed
    >
      <TabStrip
        label="Manifests and pickup requests"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "manifests", label: "Manifests" },
          { id: "requests", label: "Pickup requests", badge: pickupCounts.data?.requested },
        ]}
      />
      {tab === "requests" ? (
        <PickupRequestsPanel
          canWrite={canWrite}
          onSchedule={(r) =>
            setAnswering({
              requestId: r.id,
              code: r.code,
              merchantId: r.merchantId,
              merchantName: r.merchantName,
              pickupDate: r.pickupDate,
              window: r.window,
              awbs: r.awbs,
              notes: r.notes,
            })
          }
        />
      ) : (
      <DataTable
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as ManifestRow[]}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "Manifests are unavailable.") : null}
        onRowClick={(r) => setOpenId(r.id)}
        emptyTitle="No manifest matches these filters"
        emptyDescription="Manifests are created when a merchant declares a pickup. Clear the date or rider filter, or create one from the declared AWBs."
        filters={
          <>
            <Field label="Pickup date" className="w-44">
              <Input
                type="date"
                value={pickupDate}
                onChange={(e) => setPickupDate(e.target.value)}
                className="font-mono text-[13px]"
              />
            </Field>
            <Field label="Rider" className="w-56">
              <Select value={riderId} onChange={(e) => setRiderId(e.target.value)}>
                <option value="">All riders</option>
                {(riders.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            {pickupDate || riderId ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPickupDate("");
                  setRiderId("");
                }}
              >
                Reset
              </Button>
            ) : null}
          </>
        }
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? 25,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />
      )}

      <ManifestDrawer id={openId} onOpenChange={(open) => !open && setOpenId(null)} />
      {canWrite ? (
        <CreateManifestDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      ) : null}
      {canWrite && answering ? (
        <CreateManifestDialog
          key={answering.requestId}
          open
          prefill={answering}
          onOpenChange={(o) => !o && setAnswering(null)}
          onCreated={(id) => {
            setAnswering(null);
            setTab("manifests");
            setOpenId(id);
          }}
        />
      ) : null}
    </Page>
  );
}

function PickupRequestsPanel({
  canWrite,
  onSchedule,
}: {
  canWrite: boolean;
  onSchedule: (r: PickupRequestRow) => void;
}) {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState<"requested" | "scheduled" | "cancelled">("requested");
  const list = usePickupRequests({ page, pageSize: 25, status: [status] });

  const columns: Column<PickupRequestRow>[] = [
    { key: "code", header: "Request", width: "w-[150px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "merchant", header: "Merchant", cell: (r) => <span className="truncate">{r.merchantName}</span> },
    {
      key: "when",
      header: "Pickup",
      width: "w-[180px]",
      cell: (r) => (
        <span>
          <span className="font-mono">{r.pickupDate}</span>{" "}
          <span className="text-muted-foreground">{humanise(r.window)}</span>
        </span>
      ),
    },
    { key: "n", header: "Parcels", align: "right", width: "w-[80px]", className: "font-mono", cell: (r) => r.parcelCount },
    {
      key: "notes",
      header: status === "cancelled" ? "Reason" : status === "scheduled" ? "Manifest" : "Notes",
      cell: (r) =>
        status === "scheduled" ? (
          <MonoCell>{r.manifestCode ?? "—"}</MonoCell>
        ) : (
          <span className="truncate text-muted-foreground">{(status === "cancelled" ? r.cancelReason : r.notes) ?? "—"}</span>
        ),
    },
    {
      key: "at",
      header: "Requested",
      align: "right",
      width: "w-[150px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => dateTime(r.createdAt),
    },
    {
      key: "act",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      width: "w-[110px]",
      cell: (r) =>
        canWrite && r.status === "requested" ? (
          <Button size="sm" onClick={() => onSchedule(r)}>
            Schedule
          </Button>
        ) : null,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={list.data?.rows ?? []}
      rowKey={(r) => r.id}
      loading={list.isLoading}
      error={list.error ? apiMessage(list.error, "Pickup requests are unavailable.") : null}
      emptyTitle={status === "requested" ? "No pickup waiting for a rider" : `No ${status} requests`}
      emptyDescription="Merchants request pickups from their portal; they land here, oldest at the bottom."
      filters={
        <Field label="Status" className="w-48">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as typeof status);
              setPage(1);
            }}
          >
            <option value="requested">Waiting for a rider</option>
            <option value="scheduled">Scheduled</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </Field>
      }
      pagination={{
        page: list.data?.page ?? page,
        pageSize: list.data?.pageSize ?? 25,
        total: list.data?.total ?? 0,
        onPageChange: setPage,
      }}
      className="min-h-0 flex-1"
    />
  );
}

// ---------------------------------------------------------------- detail panel

function ManifestDrawer({
  id,
  onOpenChange,
}: {
  id: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useQuery({
    ...orpc.collection.get.queryOptions({ input: { id: id ?? "" } }),
    enabled: Boolean(id),
  });

  const manifest = detail.data?.manifest;
  const items = detail.data?.items ?? [];
  const scanned = items.filter((i) => i.scannedAt).length;

  return (
    <Drawer
      open={Boolean(id)}
      onOpenChange={onOpenChange}
      title={manifest ? manifest.code : "Manifest"}
      subtitle={detail.data ? detail.data.merchantName : undefined}
    >
      {detail.isLoading ? (
        <p className="text-[13px] text-muted-foreground">Loading manifest…</p>
      ) : detail.error ? (
        <ErrorNote>{apiMessage(detail.error, "This manifest is unavailable.")}</ErrorNote>
      ) : manifest ? (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2">
            <ManifestState status={manifest.status} />
            <Badge variant={manifest.assignmentSource === "merchant_default" ? "brand" : "muted"}>
              {manifest.assignmentSource === "merchant_default" ? "Auto-assigned" : "Manual"}
            </Badge>
            <span className="font-mono text-[12px] text-muted-foreground">
              {scanned}/{manifest.expectedCount} scanned
            </span>
          </div>

          <KeyValueGrid>
            <KeyValue label="Pickup date" mono>
              {date(manifest.pickupDate)}
            </KeyValue>
            <KeyValue label="Created" mono>
              {dateTime(manifest.createdAt)}
            </KeyValue>
            <KeyValue label="Merchant">{detail.data?.merchantName ?? "—"}</KeyValue>
            <KeyValue label="Allocation">{manifest.assignmentSource === "merchant_default" ? "Automatic — merchant default Rider" : "Manual by operations"}</KeyValue>
            <KeyValue label="Handed over" mono>
              {manifest.handedOverAt ? dateTime(manifest.handedOverAt) : "—"}
            </KeyValue>
            {manifest.handoverByName ? (
              <KeyValue label="Released by" className="col-span-2">
                {manifest.handoverByName}
              </KeyValue>
            ) : null}
          </KeyValueGrid>

          {manifest.status === "handed_over" ? (
            <SuccessNote>The assigned rider accepted custody in the Rider app. Scanned parcels may now continue through the delivery workflow.</SuccessNote>
          ) : manifest.status === "cancelled" ? (
            <ErrorNote>This manifest was cancelled. No pickup custody was recorded.</ErrorNote>
          ) : (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="label-xs mb-2 text-muted-foreground">Rider app handover required</p>
              <p className="text-[13px] text-muted-foreground">
                The assigned rider scans the parcels and confirms the merchant handover in NX Official. Scanning alone does not transfer custody; only scanned parcels move to Picked up after the rider completes handover.
              </p>
            </div>
          )}

          <div>
            <p className="label-xs mb-2 text-muted-foreground">
              Declared parcels ({items.length})
            </p>
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="font-mono text-[13px] font-medium">{item.awb}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                    {item.consigneeName ?? "—"}
                    {item.codAmountCents ? ` · COD ${amount(item.codAmountCents)}` : ""}
                  </span>
                  {item.status ? <StatusPill status={item.status} size="sm" /> : null}
                  <span
                    className={`font-mono text-[11px] ${
                      item.scannedAt ? "text-status-good" : "text-status-warn"
                    }`}
                  >
                    {item.scannedAt ? "scanned" : "pending"}
                  </span>
                </li>
              ))}
              {items.length === 0 ? (
                <li className="px-3 py-3 text-[13px] text-muted-foreground">
                  No parcels were declared on this manifest.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------- create form

/** A merchant's pickup request being answered: the manifest is pre-filled from it. */
interface ManifestPrefill {
  requestId: string;
  code: string;
  merchantId: string;
  merchantName: string;
  pickupDate: string;
  window: string;
  awbs: string[];
  notes: string | null;
}

function CreateManifestDialog({
  open,
  onOpenChange,
  onCreated,
  prefill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
  prefill?: ManifestPrefill | null;
}) {
  const queryClient = useQueryClient();
  // The dialog is keyed by the request id, so these initialisers run afresh
  // for each request answered.
  const [merchantId, setMerchantId] = React.useState(prefill?.merchantId ?? "");
  const [riderId, setRiderId] = React.useState("");
  const [pickupDate, setPickupDate] = React.useState(prefill?.pickupDate ?? colomboToday());
  const [awbText, setAwbText] = React.useState(prefill ? prefill.awbs.join("\n") : "");
  const [problem, setProblem] = React.useState<string | null>(null);
  const [offending, setOffending] = React.useState<string | null>(null);

  const merchants = useQuery({
    ...orpc.merchants.options.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });
  const riders = useQuery({
    ...orpc.identity.listRiders.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  React.useEffect(() => {
    if (!open) return;
    setProblem(null);
    setOffending(null);
  }, [open]);

  const awbs = React.useMemo(
    () =>
      awbText
        .split(/[\s,;]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    [awbText],
  );

  const create = useMutation({
    ...orpc.collection.create.mutationOptions(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries();
      setAwbText("");
      onCreated(result.manifest.id);
    },
    onError: (error) => {
      const details = apiDetails(error) as { awb?: string; currentStatus?: string };
      setProblem(apiMessage(error, "This manifest could not be created."));
      setOffending(details.awb ?? null);
    },
  });

  const ready = merchantId && riderId && pickupDate && awbs.length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={prefill ? `Schedule pickup ${prefill.code}` : "New pickup manifest"}
      description={
        prefill
          ? `${prefill.merchantName} asked for ${prefill.awbs.length} parcel(s) on ${prefill.pickupDate}, ${prefill.window}. Assign a rider; the request then reads scheduled with this manifest.`
          : "Every AWB must already be Booked and belong to the chosen merchant. The server refuses the whole manifest otherwise — nothing is created partially."
      }
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-[12px] text-muted-foreground">
            {awbs.length} AWB{awbs.length === 1 ? "" : "s"}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!ready}
              pending={create.isPending}
              onClick={() =>
                create.mutate({
                  merchantId,
                  riderId,
                  pickupDate,
                  awbs,
                  pickupRequestId: prefill?.requestId ?? null,
                })
              }
            >
              Create manifest
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Merchant">
            <Select
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
              disabled={!!prefill}
            >
              <option value="">Choose a merchant</option>
              {(merchants.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Rider">
            <Select value={riderId} onChange={(e) => setRiderId(e.target.value)}>
              <option value="">Choose a rider</option>
              {(riders.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Pickup date" hint="Asia/Colombo calendar date.">
          <Input
            type="date"
            value={pickupDate}
            onChange={(e) => setPickupDate(e.target.value)}
            className="font-mono"
          />
        </Field>
        {prefill?.notes ? (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-[13px]">
            <span className="label-xs mr-2 text-muted-foreground">Merchant note</span>
            {prefill.notes}
          </p>
        ) : null}
        <Field
          label="Declared AWBs"
          hint="One per line, or separated by spaces or commas."
        >
          <Textarea
            value={awbText}
            onChange={(e) => setAwbText(e.target.value)}
            placeholder={"NX0000000001\nNX0000000002"}
            className="min-h-[120px] font-mono text-[13px]"
          />
        </Field>
        {problem ? (
          <ErrorNote>
            {problem}
            {offending ? (
              <>
                {" "}
                Offending AWB: <span className="font-mono">{offending}</span>.
              </>
            ) : null}
          </ErrorNote>
        ) : null}
      </div>
    </Dialog>
  );
}
