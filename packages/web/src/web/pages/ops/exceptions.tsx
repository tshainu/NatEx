import * as React from "react";
import { AlertTriangle, Search, RotateCcw } from "lucide-react";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { CountRow } from "@/components/natex/metric-tile";
import { Drawer } from "@/components/ui/drawer";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { GROUP_COLOUR } from "@/lib/status";
import { dateTime, humanise, since } from "@/lib/format";
import { useExceptionResolve, useExceptions } from "@/queries/transport";

/**
 * The Ops exception queue (§7): "Every unresolved conflict appears in the Ops
 * exception queue. Silent data loss is unacceptable in a logistics system."
 *
 * Everything the custody code detects and cannot decide for itself lands here —
 * a bag arriving short, a parcel arriving that nobody sent, a seal that does not
 * match the manifest. Each one is closed by a human writing down what happened,
 * which is why the resolution note is mandatory and is kept on the record.
 */

type ExceptionStatus = "open" | "investigating" | "resolved" | "written_off";

interface ExceptionRow {
  id: string;
  kind: string;
  severity: string;
  status: string;
  branchId: string;
  awb: string | null;
  bagId: string | null;
  tripId: string | null;
  detail: string;
  evidenceJson: string | null;
  resolution: string | null;
  raisedByName: string | null;
  resolvedByName: string | null;
  resolvedAt: string | Date | null;
  createdAt: string | Date;
}

const STATUS_VARIANT: Record<string, "bad" | "warn" | "good" | "muted"> = {
  open: "bad",
  investigating: "warn",
  resolved: "good",
  written_off: "muted",
};

const SEVERITY_VARIANT: Record<string, "bad" | "warn" | "muted"> = {
  high: "bad",
  medium: "warn",
  low: "muted",
};

/** Plain language for each detector, so the queue reads as prose not enum. */
const KIND_MEANING: Record<string, string> = {
  missing_at_destination: "On the manifest, not in the bag when it was opened.",
  unexpected_at_destination: "In the bag, not on the manifest.",
  seal_mismatch: "The seal found did not match the seal recorded at despatch.",
  illegal_scan: "A scan was attempted that the state machine refused.",
  duplicate_claim: "Two parties claim custody of the same parcel.",
  count_variance: "The piece count does not reconcile.",
  stale_custody: "A parcel has sat in one custody state longer than it should.",
};

/** What the tally strip needs: how much of the queue is urgent or being worked. */
function tallySeverity(rows: ExceptionRow[]) {
  let high = 0;
  let investigating = 0;
  for (const row of rows) {
    if (row.severity === "high" && (row.status === "open" || row.status === "investigating")) {
      high += 1;
    }
    if (row.status === "investigating") investigating += 1;
  }
  return { high, investigating };
}

export default function OpsExceptions() {
  const [statusFilter, setStatusFilter] = React.useState<"unresolved" | "all" | ExceptionStatus>(
    "unresolved",
  );
  const [kind, setKind] = React.useState("");
  const [searchDraft, setSearchDraft] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  const statuses: ExceptionStatus[] | undefined =
    statusFilter === "unresolved"
      ? ["open", "investigating"]
      : statusFilter === "all"
        ? undefined
        : [statusFilter];

  const queue = useExceptions({
    ...(statuses ? { status: statuses } : {}),
    ...(kind ? { kind } : {}),
    ...(search ? { search } : {}),
  });

  const data = queue.data as { rows: ExceptionRow[]; openCount: number; total: number } | undefined;
  const rows = data?.rows ?? [];
  const selected = rows.find((row) => row.id === openId) ?? null;

  const tally = tallySeverity(rows);

  const columns: Column<ExceptionRow>[] = [
    {
      key: "raised",
      header: "Raised",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{since(row.createdAt)}</div>
          <div className="text-[11px] text-muted-foreground">{row.raisedByName ?? "system"}</div>
        </div>
      ),
    },
    {
      key: "kind",
      header: "What happened",
      cell: (row) => (
        <div className="max-w-[420px]">
          <div className="text-[13px] font-medium">{humanise(row.kind)}</div>
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
      key: "severity",
      header: "Severity",
      cell: (row) => (
        <Badge variant={SEVERITY_VARIANT[row.severity] ?? "muted"}>{humanise(row.severity)}</Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (row) => (
        <Badge variant={STATUS_VARIANT[row.status] ?? "muted"}>{humanise(row.status)}</Badge>
      ),
    },
  ];

  return (
    <Page
      title="Exception queue"
      description="Every custody conflict this hub has not yet closed. Nothing is discarded silently."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="Exceptions"
          description="Click one to read the evidence and close it."
          bodyClassName="p-0"
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={queue.isPending}
            error={queue.isError ? "The exception queue could not be loaded." : null}
            emptyTitle="Nothing unresolved"
            emptyDescription="No custody conflict is waiting on this hub. Switch the filter to All to read the ones already closed."
            onRowClick={(row) => setOpenId(row.id)}
          />
        </Card>

        <div className="space-y-4">
          <Card title="Filter">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchDraft.trim());
              }}
            >
              <Field label="Status">
                <Select
                  value={statusFilter}
                  onChange={(event) =>
                    setStatusFilter(event.target.value as "unresolved" | "all" | ExceptionStatus)
                  }
                >
                  <option value="unresolved">Unresolved (open + investigating)</option>
                  <option value="open">Open only</option>
                  <option value="investigating">Investigating</option>
                  <option value="resolved">Resolved</option>
                  <option value="written_off">Written off</option>
                  <option value="all">All</option>
                </Select>
              </Field>
              <Field label="Kind">
                <Select value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="">Any kind</option>
                  <option value="missing_at_destination">Missing at destination</option>
                  <option value="unexpected_at_destination">Unexpected at destination</option>
                  <option value="seal_mismatch">Seal mismatch</option>
                  <option value="illegal_scan">Illegal scan</option>
                  <option value="duplicate_claim">Duplicate claim</option>
                  <option value="count_variance">Count variance</option>
                  <option value="stale_custody">Stale custody</option>
                </Select>
              </Field>
              <Field label="AWB or detail contains">
                <Input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="NX2026…"
                />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" className="flex-1">
                  <Search className="size-3.5" />
                  Apply
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStatusFilter("unresolved");
                    setKind("");
                    setSearchDraft("");
                    setSearch("");
                  }}
                >
                  <RotateCcw className="size-3.5" />
                  Reset
                </Button>
              </div>
            </form>
          </Card>

          <Card title="In this view">
            <CountRow label="Still open" value={data?.openCount ?? 0} colour={GROUP_COLOUR.warn} />
            <CountRow label="Investigating" value={tally.investigating} colour={GROUP_COLOUR.moving} />
            <CountRow label="High severity" value={tally.high} colour={GROUP_COLOUR.bad} />
          </Card>

          <Card title="How an exception closes">
            <ul className="space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Investigating</span> — someone owns it
                and is looking. It stays in the queue.
              </li>
              <li>
                <span className="font-medium text-foreground">Resolved</span> — the parcel was found
                and its custody is correct again.
              </li>
              <li>
                <span className="font-medium text-foreground">Written off</span> — the parcel is
                genuinely gone. The note becomes the record finance works from.
              </li>
            </ul>
          </Card>
        </div>
      </div>

      <ResolveDrawer exception={selected} onClose={() => setOpenId(null)} />
    </Page>
  );
}

function ResolveDrawer({
  exception,
  onClose,
}: {
  exception: ExceptionRow | null;
  onClose: () => void;
}) {
  const [status, setStatus] = React.useState<"investigating" | "resolved" | "written_off">(
    "investigating",
  );
  const [resolution, setResolution] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  // Reset the form whenever a different exception is opened.
  const openId = exception?.id ?? null;
  React.useEffect(() => {
    setStatus("investigating");
    setResolution("");
    setError(null);
    setDone(null);
  }, [openId]);

  const resolve = useExceptionResolve({
    onSuccess: (row) => {
      setDone(`Marked ${humanise((row as ExceptionRow).status).toLowerCase()}.`);
      setResolution("");
      setError(null);
    },
    onError: (message) => {
      setError(message);
      setDone(null);
    },
  });

  const terminal = exception
    ? exception.status === "resolved" || exception.status === "written_off"
    : false;

  const evidence = React.useMemo(() => {
    if (!exception?.evidenceJson) return null;
    try {
      return JSON.stringify(JSON.parse(exception.evidenceJson), null, 2);
    } catch {
      // Evidence is written by the detectors, but a malformed blob must never
      // blank the screen — show it raw instead.
      return exception.evidenceJson;
    }
  }, [exception?.evidenceJson]);

  return (
    <Drawer
      open={Boolean(exception)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={exception ? humanise(exception.kind) : "Exception"}
      subtitle={exception ? `Raised ${dateTime(exception.createdAt)}` : undefined}
    >
      {!exception ? null : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[exception.status] ?? "muted"}>
              {humanise(exception.status)}
            </Badge>
            <Badge variant={SEVERITY_VARIANT[exception.severity] ?? "muted"}>
              {humanise(exception.severity)} severity
            </Badge>
          </div>

          <div className="rounded-md border border-status-warn/40 bg-status-warn/8 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warn" />
              <div>
                <p className="text-[13px] leading-relaxed">{exception.detail}</p>
                {KIND_MEANING[exception.kind] ? (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
                    {KIND_MEANING[exception.kind]}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          <KeyValueGrid>
            <KeyValue label="AWB" mono={Boolean(exception.awb)}>
              {exception.awb ?? "Not parcel-specific"}
            </KeyValue>
            <KeyValue label="Raised by">{exception.raisedByName ?? "system"}</KeyValue>
            {exception.resolvedByName ? (
              <KeyValue label="Closed by">{exception.resolvedByName}</KeyValue>
            ) : null}
            {exception.resolvedAt ? (
              <KeyValue label="Closed" mono>
                {dateTime(exception.resolvedAt)}
              </KeyValue>
            ) : null}
          </KeyValueGrid>

          {evidence ? (
            <section className="space-y-1.5">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Evidence recorded at detection
              </h4>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed">
                {evidence}
              </pre>
            </section>
          ) : null}

          {exception.resolution ? (
            <section className="space-y-1.5">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Resolution note
              </h4>
              <p className="rounded-md border p-2.5 text-[13px] leading-relaxed">
                {exception.resolution}
              </p>
            </section>
          ) : null}

          {terminal ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              This exception is closed. A closed exception is never reopened — if the same conflict
              recurs, the detector raises a fresh one so the history stays intact.
            </p>
          ) : (
            <form
              className="space-y-3 border-t pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                resolve.mutate({ exceptionId: exception.id, status, resolution: resolution.trim() });
              }}
            >
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Close it out
              </h4>
              <Field label="Outcome">
                <Select
                  value={status}
                  onChange={(event) =>
                    setStatus(event.target.value as "investigating" | "resolved" | "written_off")
                  }
                >
                  <option value="investigating">Investigating — keep it in the queue</option>
                  <option value="resolved">Resolved — custody is correct again</option>
                  <option value="written_off">Written off — the parcel is gone</option>
                </Select>
              </Field>
              <Field
                label="What happened"
                hint="Kept on the record permanently. Finance and the merchant may both read it."
              >
                <Textarea
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  rows={4}
                  placeholder="Found in the Kandy overflow cage; re-scanned into bag BAG7K2F. Bag seal was intact."
                />
              </Field>
              {error ? <ErrorNote>{error}</ErrorNote> : null}
              {done ? <SuccessNote>{done}</SuccessNote> : null}
              <Button
                type="submit"
                size="sm"
                pending={resolve.isPending}
                disabled={resolution.trim().length < 5}
                className="w-full"
              >
                Record the outcome
              </Button>
              {resolution.trim().length < 5 ? (
                <p className="text-[11px] text-muted-foreground">
                  A note of at least five characters is required — §7 does not allow an exception to
                  be closed without one.
                </p>
              ) : null}
            </form>
          )}
        </div>
      )}
    </Drawer>
  );
}
