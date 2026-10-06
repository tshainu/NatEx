import * as React from "react";
import { Search, RotateCcw } from "lucide-react";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { CountRow } from "@/components/natex/metric-tile";
import { GROUP_COLOUR } from "@/lib/status";
import { Drawer } from "@/components/ui/drawer";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { dateTime, humanise, since } from "@/lib/format";
import { useCustodyChain, useScanLog } from "@/queries/transport";

/**
 * The hub scan log (§7, §10 M2). Every scan is written down — including the
 * ones the server refused — because a rejected scan is the evidence that
 * someone tried to move a parcel illegally, and throwing it away is the silent
 * data loss §7 forbids.
 *
 * Clicking a row opens that parcel's chain of custody: the bag legs, the trips
 * and every scan against it, in order.
 */

type ScanKind = "bag_in" | "bag_out" | "parcel_in" | "parcel_out" | "bag_receive" | "trip_load";
type Outcome = "accepted" | "duplicate" | "rejected";

interface ScanRow {
  id: string;
  ts: string | Date;
  kind: string;
  outcome: string;
  awb: string | null;
  reason: string | null;
  bagId: string | null;
  tripId: string | null;
  branchId: string;
  actorName: string | null;
  deviceId: string | null;
}

const OUTCOME_VARIANT: Record<string, "good" | "warn" | "bad"> = {
  accepted: "good",
  duplicate: "warn",
  rejected: "bad",
};

const KIND_LABEL: Record<string, string> = {
  bag_in: "Into bag",
  bag_out: "Out of bag",
  parcel_in: "Parcel in",
  parcel_out: "Parcel out",
  bag_receive: "Bag receipt",
  trip_load: "Trip load",
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? humanise(kind);
}

/** Outcome counts for the tally strip — the three states a scan can land in. */
function tallyOutcomes(rows: ScanRow[]) {
  let accepted = 0;
  let duplicate = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.outcome === "accepted") accepted += 1;
    else if (row.outcome === "duplicate") duplicate += 1;
    else if (row.outcome === "rejected") rejected += 1;
  }
  return { accepted, duplicate, rejected };
}

export default function OpsScanLog() {
  const [kind, setKind] = React.useState<"" | ScanKind>("");
  const [outcome, setOutcome] = React.useState<"" | Outcome>("");
  const [searchDraft, setSearchDraft] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);

  const log = useScanLog({
    ...(kind ? { kind } : {}),
    ...(outcome ? { outcome } : {}),
    ...(search ? { search } : {}),
    limit: 150,
  });

  const rows: ScanRow[] = log.data ?? [];
  const tally = tallyOutcomes(rows);

  const columns: Column<ScanRow>[] = [
    {
      key: "ts",
      header: "When",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{since(row.ts)}</div>
          <div className="text-[11px] text-muted-foreground">{dateTime(row.ts)}</div>
        </div>
      ),
    },
    {
      key: "awb",
      header: "AWB",
      cell: (row) => (row.awb ? <MonoCell>{row.awb}</MonoCell> : <span className="text-muted-foreground">—</span>),
    },
    { key: "kind", header: "Scan", cell: (row) => kindLabel(row.kind) },
    {
      key: "outcome",
      header: "Outcome",
      cell: (row) => (
        <Badge variant={OUTCOME_VARIANT[row.outcome] ?? "muted"}>{humanise(row.outcome)}</Badge>
      ),
    },
    {
      key: "reason",
      header: "Why",
      cell: (row) =>
        row.reason ? (
          <span className="text-[12px] leading-snug text-muted-foreground">{row.reason}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "who",
      header: "Scanned by",
      cell: (row) => (
        <div>
          <div className="text-[13px]">{row.actorName ?? "—"}</div>
          {row.deviceId ? (
            <div className="font-mono text-[11px] text-muted-foreground">{row.deviceId}</div>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <Page
      title="Hub scan log"
      description="Every scan taken at this hub, in order, including the ones the server refused."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          title="Scans"
          description={`${rows.length} most recent${search ? ` matching ${search}` : ""}`}
          bodyClassName="p-0"
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            loading={log.isPending}
            emptyTitle="No scans match these filters"
            emptyDescription="Widen the filter, or clear the AWB search. An empty log at a quiet hub is normal."
            onRowClick={(row) => (row.awb ? setOpenAwb(row.awb) : undefined)}
          />
        </Card>

        <div className="space-y-4">
          <Card title="Filter">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchDraft.trim().toUpperCase());
              }}
            >
              <Field label="AWB contains">
                <Input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="NX2026…"
                  className="font-mono"
                />
              </Field>
              <Field label="Scan type">
                <Select value={kind} onChange={(event) => setKind(event.target.value as "" | ScanKind)}>
                  <option value="">Any type</option>
                  <option value="bag_in">Into bag</option>
                  <option value="bag_out">Out of bag</option>
                  <option value="bag_receive">Bag receipt</option>
                  <option value="trip_load">Trip load</option>
                  <option value="parcel_in">Parcel in</option>
                  <option value="parcel_out">Parcel out</option>
                </Select>
              </Field>
              <Field label="Outcome">
                <Select
                  value={outcome}
                  onChange={(event) => setOutcome(event.target.value as "" | Outcome)}
                >
                  <option value="">Any outcome</option>
                  <option value="accepted">Accepted</option>
                  <option value="duplicate">Duplicate</option>
                  <option value="rejected">Rejected</option>
                </Select>
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
                    setKind("");
                    setOutcome("");
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
            <CountRow label="Accepted" value={tally.accepted} colour={GROUP_COLOUR.good} />
            <CountRow label="Duplicate" value={tally.duplicate} colour={GROUP_COLOUR.moving} />
            <CountRow label="Rejected" value={tally.rejected} colour={GROUP_COLOUR.warn} />
          </Card>

          <Card title="Why rejected scans are kept">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              A refused scan is evidence. It records that a label was presented somewhere it should
              not have been — wrong hub, wrong bag, already sealed, already delivered — and who
              presented it. §7 treats discarding that as silent data loss, so the log keeps it next
              to the reason the server gave.
            </p>
          </Card>
        </div>
      </div>

      <CustodyDrawer awb={openAwb} onClose={() => setOpenAwb(null)} />
    </Page>
  );
}

/** The chain of custody for one AWB — bag legs, trips, scans, exceptions. */
function CustodyDrawer({ awb, onClose }: { awb: string | null; onClose: () => void }) {
  const chain = useCustodyChain(awb);
  const data = chain.data as
    // transportService.custodyChain: getParcelDetail + bags + scans + exceptions.
    | {
        parcel: { awb: string; status: string; codAmountCents?: number | null };
        bags: {
          bagId: string;
          bagCode: string;
          bagStatus: string;
          seal: string | null;
          originHubName: string;
          destHubName: string;
          scannedAt: string | Date;
          scannedByName: string | null;
          removedAt: string | Date | null;
          tripCode: string | null;
          tripVehicle: string | null;
          tripSeal: string | null;
          departedAt: string | Date | null;
          arrivedAt: string | Date | null;
        }[];
        scans: ScanRow[];
        exceptions: { id: string; kind: string; status: string; detail: string }[];
      }
    | undefined;

  return (
    <Drawer
      open={Boolean(awb)}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={awb ? `Custody of ${awb}` : "Custody"}
      subtitle="Physical custody, not just status changes."
    >
      <ErrorBoundary key={awb ?? "closed"}>
      {chain.isPending ? (
        <p className="text-[13px] text-muted-foreground">Loading the chain…</p>
      ) : chain.isError ? (
        <p className="text-[13px] text-muted-foreground">
          The custody chain could not be loaded for this AWB.
        </p>
      ) : !data ? (
        <p className="text-[13px] text-muted-foreground">Nothing recorded against this AWB.</p>
      ) : (
        <div className="space-y-5">
          <KeyValueGrid>
            <KeyValue label="AWB" mono>
              {data.parcel.awb}
            </KeyValue>
            <KeyValue label="Status">{humanise(data.parcel.status)}</KeyValue>
          </KeyValueGrid>

          <section className="space-y-2">
            <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bag legs
            </h4>
            {data.bags.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Never bagged.</p>
            ) : (
              data.bags.map((leg) => (
                <div key={`${leg.bagId}-${String(leg.scannedAt)}`} className="rounded-md border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px]">{leg.bagCode}</span>
                    <Badge variant="muted">{humanise(leg.bagStatus)}</Badge>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {leg.originHubName} → {leg.destHubName}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    scanned in {dateTime(leg.scannedAt)}
                    {leg.scannedByName ? ` by ${leg.scannedByName}` : ""}
                    {leg.seal ? ` · seal ${leg.seal}` : ""}
                  </div>
                  {leg.tripCode ? (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      trip {leg.tripCode}
                      {leg.tripVehicle ? ` · ${leg.tripVehicle}` : ""}
                      {leg.departedAt ? ` · departed ${dateTime(leg.departedAt)}` : ""}
                      {leg.arrivedAt ? ` · arrived ${dateTime(leg.arrivedAt)}` : ""}
                    </div>
                  ) : null}
                  {leg.removedAt ? (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      taken out {dateTime(leg.removedAt)}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </section>

          <section className="space-y-2">
            <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Scans
            </h4>
            {data.scans.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No scans.</p>
            ) : (
              data.scans.map((scan) => (
                <div key={scan.id} className="flex items-start justify-between gap-2 rounded-md border p-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px]">{kindLabel(scan.kind)}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {dateTime(scan.ts)}
                      {scan.actorName ? ` · ${scan.actorName}` : ""}
                    </div>
                    {scan.reason ? (
                      <div className="mt-0.5 text-[11px] leading-snug text-status-bad">{scan.reason}</div>
                    ) : null}
                  </div>
                  <Badge variant={OUTCOME_VARIANT[scan.outcome] ?? "muted"}>
                    {humanise(scan.outcome)}
                  </Badge>
                </div>
              ))
            )}
          </section>

          {data.exceptions.length > 0 ? (
            <section className="space-y-2">
              <h4 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Exceptions
              </h4>
              {data.exceptions.map((exception) => (
                <div key={exception.id} className="rounded-md border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px]">{humanise(exception.kind)}</span>
                    <Badge variant={exception.status === "open" ? "bad" : "muted"}>
                      {humanise(exception.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {exception.detail}
                  </p>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      )}
      </ErrorBoundary>
    </Drawer>
  );
}
