import * as React from "react";
import { AlertTriangle, Clock, RotateCcw, Smartphone } from "lucide-react";
import { Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { CountRow } from "@/components/natex/metric-tile";
import { Drawer } from "@/components/ui/drawer";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { GROUP_COLOUR } from "@/lib/status";
import { dateTime, humanise, since } from "@/lib/format";
import {
  useSyncConflict,
  useSyncConflictClaim,
  useSyncConflictCounts,
  useSyncConflictResolve,
  useSyncConflicts,
  useSyncDevices,
  type ConflictPolicy,
  type ConflictResolution,
  type ConflictState,
} from "@/queries/sync";

/**
 * The sync conflict queue — the last clause of PROJECT.md §7: "Every
 * unresolved conflict appears in the Ops exception queue. Silent data loss is
 * unacceptable in a logistics system."
 *
 * This is a DIFFERENT queue from /ops/exceptions. That one holds custody
 * exceptions the transport module raises (a bag short, a seal mismatch) and is
 * shared with transport clerks. This one holds what the offline engine could
 * not decide for itself when a device's outbox drained: two riders claiming one
 * parcel, a delivery confirmed offline on a parcel the server had already
 * failed, an operation that is not legal from the state the server holds. The
 * routes behind it are ops-and-admin only.
 *
 * The screen's whole job is to put the device's claim and the server's state
 * next to each other and make a human write down which one is right and why.
 * There is deliberately no "force it through" button: accepting the client's
 * claim records a DECISION, and the correction is then made through the normal
 * audited endpoint so it passes the state machine that refused it in the first
 * place (§6 — corrections are reversal events, never edits).
 */

interface ConflictRow {
  id: string;
  operationId: string;
  clientOpId: string;
  policy: string;
  kind: string;
  deviceId: string | null;
  userId: string | null;
  userName: string | null;
  branchId: string | null;
  parcelId: string | null;
  awb: string | null;
  detail: string;
  clientClaim: unknown;
  serverState: unknown;
  state: string;
  resolution: string | null;
  resolutionNotes: string | null;
  resolvedByName: string | null;
  resolvedAt: string | Date | null;
  createdAt: string | Date;
}

interface DeviceRow {
  deviceId: string;
  userId: string;
  userName: string | null;
  userRole: string | null;
  branchId: string | null;
  cursor: number;
  lastPullAt: string | Date | null;
  lastPushAt: string | Date | null;
  pendingReported: number;
  appVersion: string | null;
  opsPushed: number;
  opsRejected: number;
  clockSkewSeconds: number;
  worstClockSkewSeconds: number;
  clockSuspect: boolean;
  lastOperationAt: string | Date | null;
}

const STATE_VARIANT: Record<string, "bad" | "warn" | "good" | "muted"> = {
  open: "bad",
  reviewing: "warn",
  resolved: "good",
  dismissed: "muted",
};

/**
 * §7's conflict policy table, in plain language. The enum name is what the
 * engine writes; this is what the ops user actually needs to understand before
 * deciding. Each line is the policy as PROJECT.md states it.
 */
const POLICY_MEANING: Record<string, string> = {
  duplicate_operation:
    "The same parcel was transitioned twice. The first operation won; this one was deduped on its client ID and never re-applied.",
  duplicate_claim:
    "Two riders claim the same parcel. The server rejected the later claim — the device that lost shows its rider a notice.",
  offline_delivery_vs_fail:
    "A delivery was confirmed offline on a parcel the server had already failed. Flagged for manual review — never silently overwritten.",
  double_cod:
    "COD was collected twice for one parcel. The second entry was rejected and both appear in reconciliation.",
  stale_runsheet:
    "The runsheet was reassigned while the device was offline. The client discards its stale copy and re-pulls on the next sync.",
  illegal_state:
    "The operation is not legal from the state the server holds. The state machine refused it (§6) and the payload was kept in full.",
  unknown_kind:
    "The device pushed an operation kind this server does not know — usually an app version older or newer than the API. Recorded, not dropped.",
};

/**
 * What each resolution means on the record. The wording matters: `accepted_client`
 * does not re-drive anything, and an ops user choosing it should know that.
 */
const RESOLUTION_MEANING: Record<ConflictResolution, string> = {
  accepted_client:
    "The device was right — record that, then make the correction through the normal endpoint.",
  kept_server: "The server's state stands. The device's claim is wrong and is discarded.",
  manual_correction: "Neither was right. The correction was made by hand elsewhere.",
  dismissed: "Not a real conflict — no data was at risk.",
};

const POLICY_ORDER: ConflictPolicy[] = [
  "duplicate_claim",
  "offline_delivery_vs_fail",
  "double_cod",
  "stale_runsheet",
  "illegal_state",
  "duplicate_operation",
  "unknown_kind",
];

/** A skew reading, as seconds, rendered the way an ops user reads a clock fault. */
function skew(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const abs = Math.abs(seconds);
  const direction = seconds >= 0 ? "ahead" : "behind";
  if (abs < 60) return `${abs}s ${direction}`;
  return `${Math.round(abs / 60)} min ${direction}`;
}

export default function OpsSyncConflicts() {
  const [stateFilter, setStateFilter] = React.useState<"unresolved" | "all" | ConflictState>(
    "unresolved",
  );
  const [policy, setPolicy] = React.useState<"" | ConflictPolicy>("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  const states: ConflictState[] | undefined =
    stateFilter === "unresolved"
      ? ["open", "reviewing"]
      : stateFilter === "all"
        ? undefined
        : [stateFilter];

  const queue = useSyncConflicts({
    ...(states ? { state: states } : {}),
    ...(policy ? { policy } : {}),
  });
  const counts = useSyncConflictCounts();
  const fleet = useSyncDevices();

  const rows = (queue.data as ConflictRow[] | undefined) ?? [];
  const tally = counts.data as
    | { open: number; resolved: number; byPolicy: Record<string, number> }
    | undefined;
  const devices = (fleet.data as DeviceRow[] | undefined) ?? [];

  const suspectClocks = devices.filter((d) => d.clockSuspect).length;
  const backlog = devices.reduce((sum, d) => sum + d.pendingReported, 0);

  const columns: Column<ConflictRow>[] = [
    {
      key: "raised",
      header: "Raised",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{since(row.createdAt)}</div>
          <div className="text-[11px] text-muted-foreground">{row.userName ?? "unknown rider"}</div>
        </div>
      ),
    },
    {
      key: "policy",
      header: "What the engine could not decide",
      cell: (row) => (
        <div className="max-w-[420px]">
          <div className="text-[13px] font-medium">{humanise(row.policy)}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{row.detail}</div>
        </div>
      ),
    },
    {
      key: "awb",
      header: "AWB",
      cell: (row) =>
        row.awb ? <MonoCell>{row.awb}</MonoCell> : <span className="text-muted-foreground">—</span>,
    },
    {
      key: "kind",
      header: "Operation",
      cell: (row) => <MonoCell>{row.kind}</MonoCell>,
    },
    {
      key: "device",
      header: "Device",
      cell: (row) =>
        row.deviceId ? (
          <MonoCell>{row.deviceId}</MonoCell>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "state",
      header: "State",
      cell: (row) => (
        <Badge variant={STATE_VARIANT[row.state] ?? "muted"}>{humanise(row.state)}</Badge>
      ),
    },
  ];

  return (
    <Page
      title="Sync conflicts"
      description="What the offline engine refused to decide on its own. Nothing here was dropped — every operation is still in the journal with its full payload."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="Conflict queue"
          description="Click one to read the device's claim against the server's state."
          bodyClassName="p-0"
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={queue.isPending}
            error={queue.isError ? "The conflict queue could not be loaded." : null}
            emptyTitle="No unresolved conflicts"
            emptyDescription="Every device that has synced with this hub landed its operations cleanly. Switch the filter to All to read the ones already closed."
            onRowClick={(row) => setOpenId(row.id)}
          />
        </Card>

        <div className="space-y-4">
          <Card title="Filter">
            <div className="space-y-3">
              <Field label="State">
                <Select
                  value={stateFilter}
                  onChange={(event) =>
                    setStateFilter(event.target.value as "unresolved" | "all" | ConflictState)
                  }
                >
                  <option value="unresolved">Unresolved (open + reviewing)</option>
                  <option value="open">Open only</option>
                  <option value="reviewing">Being reviewed</option>
                  <option value="resolved">Resolved</option>
                  <option value="dismissed">Dismissed</option>
                  <option value="all">All</option>
                </Select>
              </Field>
              <Field label="Policy">
                <Select
                  value={policy}
                  onChange={(event) => setPolicy(event.target.value as "" | ConflictPolicy)}
                >
                  <option value="">Any policy</option>
                  {POLICY_ORDER.map((p) => (
                    <option key={p} value={p}>
                      {humanise(p)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setStateFilter("unresolved");
                  setPolicy("");
                }}
                className="w-full"
              >
                <RotateCcw className="size-3.5" />
                Reset
              </Button>
            </div>
          </Card>

          <Card title="Open by policy" description="Counts are for this branch only (§5).">
            {tally && tally.open > 0 ? (
              POLICY_ORDER.filter((p) => (tally.byPolicy[p] ?? 0) > 0).map((p) => (
                <CountRow
                  key={p}
                  label={humanise(p)}
                  value={tally.byPolicy[p] ?? 0}
                  colour={p === "duplicate_operation" ? GROUP_COLOUR.moving : GROUP_COLOUR.bad}
                  active={policy === p}
                  onClick={() => setPolicy(policy === p ? "" : p)}
                />
              ))
            ) : (
              <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
                {counts.isPending ? "Counting…" : "Nothing open."}
              </p>
            )}
            <div className="mt-2 border-t pt-2">
              <CountRow
                label="Closed to date"
                value={tally?.resolved ?? 0}
                colour={GROUP_COLOUR.good}
              />
            </div>
          </Card>

          <Card
            title="Fleet health"
            description="§7 treats a skewed clock as normal — the engine never orders by it. Ops still needs to see it."
          >
            <CountRow
              label="Devices synced"
              value={devices.length}
              colour={GROUP_COLOUR.created}
            />
            <CountRow
              label="Operations still queued"
              value={backlog}
              colour={GROUP_COLOUR.moving}
            />
            <CountRow
              label="Clocks out by 30 min or more"
              value={suspectClocks}
              colour={GROUP_COLOUR.warn}
            />
          </Card>
        </div>
      </div>

      {devices.length > 0 ? <FleetCard devices={devices} /> : null}

      <ConflictDrawer conflictId={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}

/**
 * The fleet table. Not a separate screen: a conflict is almost always read
 * together with "is this device healthy?", and a device 40 minutes out of clock
 * is the reason a custody dispute six months from now will hinge on which
 * timestamp is believed.
 */
function FleetCard({ devices }: { devices: DeviceRow[] }) {
  const columns: Column<DeviceRow>[] = [
    {
      key: "device",
      header: "Device",
      cell: (row) => (
        <div>
          <MonoCell>{row.deviceId}</MonoCell>
          {row.appVersion ? (
            <div className="text-[11px] text-muted-foreground">app {row.appVersion}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: "who",
      header: "Carried by",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{row.userName ?? row.userId}</div>
          <div className="text-[11px] text-muted-foreground">
            {row.userRole ? humanise(row.userRole) : "—"}
            {row.branchId ? ` · ${row.branchId}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "contact",
      header: "Last contact",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{row.lastPushAt ? since(row.lastPushAt) : "never pushed"}</div>
          <div className="text-[11px] text-muted-foreground">
            pulled {row.lastPullAt ? since(row.lastPullAt) : "never"}
          </div>
        </div>
      ),
    },
    {
      key: "queued",
      header: "Queued",
      cell: (row) =>
        row.pendingReported > 0 ? (
          <Badge variant="warn">{row.pendingReported} waiting</Badge>
        ) : (
          <span className="text-[13px] text-muted-foreground">drained</span>
        ),
    },
    {
      key: "landed",
      header: "Landed",
      cell: (row) => (
        <div className="text-[13px]">
          {row.opsPushed}
          {row.opsRejected > 0 ? (
            <span className="text-[11px] text-status-warn"> · {row.opsRejected} refused</span>
          ) : null}
        </div>
      ),
    },
    {
      key: "clock",
      header: "Clock",
      cell: (row) =>
        row.clockSuspect ? (
          <Badge variant="bad">worst {skew(row.worstClockSkewSeconds)}</Badge>
        ) : (
          <span className="text-[13px] text-muted-foreground">{skew(row.clockSkewSeconds)}</span>
        ),
    },
  ];

  return (
    <Card
      title="Devices"
      description="Every device that has drained an outbox against this branch."
      bodyClassName="p-0"
      className="mt-4"
    >
      <DataTable
        columns={columns}
        rows={devices}
        rowKey={(row) => row.deviceId}
        emptyTitle="No devices"
        emptyDescription="No device has synced against this branch yet."
      />
    </Card>
  );
}

function ConflictDrawer({
  conflictId,
  onClose,
}: {
  conflictId: string | null;
  onClose: () => void;
}) {
  const [resolution, setResolution] = React.useState<ConflictResolution>("kept_server");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  // Reset the form whenever a different conflict is opened.
  React.useEffect(() => {
    setResolution("kept_server");
    setNotes("");
    setError(null);
    setDone(null);
  }, [conflictId]);

  const detail = useSyncConflict(conflictId);
  const data = detail.data as
    | {
        conflict: ConflictRow;
        operation:
          | {
              id: string;
              kind: string;
              seq: number;
              state: string;
              error: string | null;
              payload: unknown;
              clientTs: string | Date | null;
              clockSkewSeconds: number | null;
              receivedAt: string | Date;
              appliedAt: string | Date | null;
            }
          | null;
      }
    | undefined;
  const conflict = data?.conflict ?? null;
  const operation = data?.operation ?? null;

  const claim = useSyncConflictClaim({
    onSuccess: () => {
      setDone("Claimed — it is yours to work. Nobody else can resolve it now.");
      setError(null);
    },
    onError: (message) => {
      setError(message);
      setDone(null);
    },
  });

  const resolve = useSyncConflictResolve({
    onSuccess: () => {
      setDone("Decision recorded. The note is now part of the parcel's permanent trail.");
      setNotes("");
      setError(null);
    },
    onError: (message) => {
      setError(message);
      setDone(null);
    },
  });

  const terminal = conflict ? conflict.state === "resolved" || conflict.state === "dismissed" : false;

  return (
    <Drawer
      open={Boolean(conflictId)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={conflict ? humanise(conflict.policy) : "Sync conflict"}
      subtitle={conflict ? `Raised ${dateTime(conflict.createdAt)}` : undefined}
    >
      {detail.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading the conflict…</p>
      ) : detail.isError ? (
        <ErrorNote>That conflict could not be read. It may belong to another branch.</ErrorNote>
      ) : !conflict ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_VARIANT[conflict.state] ?? "muted"}>
              {humanise(conflict.state)}
            </Badge>
            <Badge variant="muted">{conflict.kind}</Badge>
          </div>

          <div className="rounded-md border border-status-warn/40 bg-status-warn/8 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warn" />
              <div>
                <p className="text-[13px] leading-relaxed">{conflict.detail}</p>
                {POLICY_MEANING[conflict.policy] ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {POLICY_MEANING[conflict.policy]}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <KeyValueGrid>
            <KeyValue label="AWB" mono={Boolean(conflict.awb)}>
              {conflict.awb ?? "Not parcel-specific"}
            </KeyValue>
            <KeyValue label="Raised by">{conflict.userName ?? "unknown"}</KeyValue>
            <KeyValue label="Device" mono={Boolean(conflict.deviceId)}>
              {conflict.deviceId ?? "—"}
            </KeyValue>
            <KeyValue label="Client operation ID" mono>
              {conflict.clientOpId}
            </KeyValue>
            {conflict.resolvedByName ? (
              <KeyValue label={terminal ? "Closed by" : "Held by"}>
                {conflict.resolvedByName}
              </KeyValue>
            ) : null}
            {conflict.resolvedAt ? (
              <KeyValue label="Closed" mono>
                {dateTime(conflict.resolvedAt)}
              </KeyValue>
            ) : null}
          </KeyValueGrid>

          {/* The whole point of the screen: the two versions of the truth, side by side. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <ClaimPane
              heading="What the device claimed"
              icon={<Smartphone className="size-3.5" />}
              value={conflict.clientClaim}
            />
            <ClaimPane
              heading="What the server holds"
              icon={<Clock className="size-3.5" />}
              value={conflict.serverState}
            />
          </div>

          {operation ? (
            <section className="space-y-1.5">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Journal entry
              </h4>
              <KeyValueGrid>
                <KeyValue label="Device seq" mono>
                  {String(operation.seq)}
                </KeyValue>
                <KeyValue label="Verdict">{humanise(operation.state)}</KeyValue>
                <KeyValue label="Captured on device" mono>
                  {operation.clientTs ? dateTime(operation.clientTs) : "—"}
                </KeyValue>
                <KeyValue label="Received by server" mono>
                  {dateTime(operation.receivedAt)}
                </KeyValue>
                <KeyValue label="Clock skew">{skew(operation.clockSkewSeconds)}</KeyValue>
              </KeyValueGrid>
              {operation.error ? (
                <p className="rounded-md border border-status-warn/40 bg-status-warn/8 p-2.5 text-[12px] leading-relaxed">
                  {operation.error}
                </p>
              ) : null}
              <details>
                <summary className="cursor-pointer text-[12px] text-muted-foreground hover:text-foreground">
                  The payload as the device queued it
                </summary>
                <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
                  {JSON.stringify(operation.payload, null, 2)}
                </pre>
              </details>
            </section>
          ) : null}

          {conflict.resolutionNotes ? (
            <section className="space-y-1.5">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Decision on record
                {conflict.resolution ? ` — ${humanise(conflict.resolution)}` : ""}
              </h4>
              <p className="rounded-md border p-2.5 text-[13px] leading-relaxed">
                {conflict.resolutionNotes}
              </p>
            </section>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {done ? <SuccessNote>{done}</SuccessNote> : null}

          {terminal ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This conflict is closed. It is never reopened — if the same clash recurs on the next
              sync, the engine raises a fresh one so the history stays intact.
            </p>
          ) : (
            <div className="space-y-4 border-t pt-4">
              {conflict.state === "open" ? (
                <div className="space-y-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full"
                    pending={claim.isPending}
                    onClick={() => {
                      setError(null);
                      claim.mutate({ conflictId: conflict.id });
                    }}
                  >
                    Claim it for review
                  </Button>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Optional, but it stops a second ops user working the same dispute — the server
                    refuses the later claimant rather than letting both decide.
                  </p>
                </div>
              ) : null}

              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setError(null);
                  resolve.mutate({ conflictId: conflict.id, resolution, notes: notes.trim() });
                }}
              >
                <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Decide it
                </h4>
                <Field label="Outcome" hint={RESOLUTION_MEANING[resolution]}>
                  <Select
                    value={resolution}
                    onChange={(event) =>
                      setResolution(event.target.value as ConflictResolution)
                    }
                  >
                    <option value="kept_server">Kept the server's state</option>
                    <option value="accepted_client">The device was right</option>
                    <option value="manual_correction">Corrected by hand</option>
                    <option value="dismissed">Dismissed — not a real conflict</option>
                  </Select>
                </Field>
                <Field
                  label="What was decided and why"
                  hint="Required. Kept permanently — finance and the merchant may both read it."
                >
                  <Textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    rows={4}
                    placeholder="Rang the consignee: the parcel was handed over at 16:40, the rider's phone had no signal until 18:00. Server's failed status is wrong; raising a reversal on NX2026…"
                  />
                </Field>
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  pending={resolve.isPending}
                  disabled={notes.trim().length < 5}
                >
                  Record the decision
                </Button>
                {notes.trim().length < 5 ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    A note of at least five characters is required — §7 calls silent data loss
                    unacceptable, and a resolution with no account of why is not an audit trail.
                  </p>
                ) : null}
                {resolution === "accepted_client" ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Recording this does not re-drive the operation. Re-applying it from here would
                    bypass the state machine that refused it — make the correction through the
                    normal endpoint, as a reversal (§6).
                  </p>
                ) : null}
              </form>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

/** One side of the claim/state comparison. Empty is stated, never left blank. */
function ClaimPane({
  heading,
  icon,
  value,
}: {
  heading: string;
  icon: React.ReactNode;
  value: unknown;
}) {
  const body = React.useMemo(() => {
    if (value === null || value === undefined) return null;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return (
    <section className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {heading}
      </h4>
      {body ? (
        <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
          {body}
        </pre>
      ) : (
        <p className="rounded-md border border-dashed p-2.5 text-[12px] text-muted-foreground">
          The engine recorded nothing for this side.
        </p>
      )}
    </section>
  );
}
