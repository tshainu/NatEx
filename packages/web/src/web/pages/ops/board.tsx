import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, RefreshCw, AlertTriangle } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { since, humanise, time } from "@/lib/format";
import { boardRank, isException, statusColour, GROUP_COLOUR } from "@/lib/status";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { MetricTile, CountRow } from "@/components/natex/metric-tile";
import { ParcelDrawer } from "@/components/natex/parcel-drawer";
import { ErrorNote } from "@/components/natex/page";

/**
 * Ops live board — the one intentionally asymmetric, dark screen (design.md):
 * a wide parcel stream on the left (2fr) and a narrow stacked column of count
 * tiles + exception feed on the right (1fr).
 *
 * Realtime: PROJECT.md §8 specifies Socket.io. Runable's template has no
 * websocket server, so this polls every 5s through TanStack Query — logged in
 * the README as a known deviation, not hidden. A row whose status changed
 * between polls gets the amber left-border flash.
 */

const POLL_MS = 5000;

interface BoardRow {
  id: string;
  awb: string;
  status: string;
  consigneeName: string;
  updatedAt: string | Date;
  codAmountCents: number;
}

export default function OpsBoard() {
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [openAwb, setOpenAwb] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // design.md: "/" focuses search on the ops board.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const board = useQuery({
    ...orpc.parcels.board.queryOptions(),
    refetchInterval: POLL_MS,
  });

  const debounced = useDebounced(search, 250);
  React.useEffect(() => setPage(1), [debounced, statusFilter]);

  const parcels = useQuery({
    ...orpc.parcels.list.queryOptions({
      input: {
        page,
        pageSize: 25,
        search: debounced.trim() || undefined,
        status: statusFilter ? [statusFilter] : undefined,
      },
    }),
    refetchInterval: POLL_MS,
  });

  const rows = (parcels.data?.rows ?? []) as unknown as BoardRow[];
  const flashed = useStatusFlash(rows);

  const counts = React.useMemo(() => {
    const list = board.data?.counts ?? [];
    return [...list].sort((a, b) => boardRank(a.status) - boardRank(b.status));
  }, [board.data]);

  const total = counts.reduce((sum, c) => sum + c.count, 0);
  const inCustody = counts
    .filter((c) => ["PickedUp", "AtOriginHub", "Bagged", "InTransit", "AtDestHub", "OutForDelivery"].includes(c.status))
    .reduce((sum, c) => sum + c.count, 0);
  const exceptions = counts
    .filter((c) => isException(c.status))
    .reduce((sum, c) => sum + c.count, 0);
  const booked = counts.find((c) => c.status === "Booked")?.count ?? 0;

  const exceptionEvents = (board.data?.events ?? []).filter((e) => isException(e.toStatus));

  const columns: Column<BoardRow>[] = [
    {
      key: "awb",
      header: "AWB",
      width: "w-[150px]",
      cell: (row) => <MonoCell>{row.awb}</MonoCell>,
    },
    {
      key: "status",
      header: "Status",
      width: "w-[150px]",
      cell: (row) => <StatusPill status={row.status} />,
    },
    {
      key: "consignee",
      header: "Consignee",
      cell: (row) => <span className="truncate">{row.consigneeName}</span>,
    },
    {
      key: "cod",
      header: "COD",
      align: "right",
      width: "w-[120px]",
      className: "font-mono",
      cell: (row) =>
        row.codAmountCents > 0 ? (
          (row.codAmountCents / 100).toLocaleString("en-LK", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "updated",
      header: "Last change",
      align: "right",
      width: "w-[120px]",
      className: "text-muted-foreground",
      cell: (row) => since(row.updatedAt),
    },
  ];

  return (
    <div className="dark h-full bg-ink-900 text-text-hi">
      <div className="flex h-full min-h-0 flex-col gap-5 p-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-[24px] font-bold">Live board</h1>
            <p className="mt-0.5 flex items-center gap-2 text-[12px] text-text-lo">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ backgroundColor: GROUP_COLOUR.good }}
              />
              Polling every {POLL_MS / 1000}s
              {board.data ? ` · updated ${time(board.data.generatedAt)}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-lo"
                aria-hidden
              />
              <Input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="AWB, consignee, phone   /"
                className="w-72 border-ink-600 bg-ink-800 pl-8 font-mono text-[13px] text-text-hi placeholder:text-text-lo"
              />
            </div>
            <Button
              variant="dark"
              size="icon"
              aria-label="Refresh now"
              onClick={() => {
                void board.refetch();
                void parcels.refetch();
              }}
            >
              <RefreshCw className={cn(parcels.isFetching && "animate-spin")} />
            </Button>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 xl:grid-cols-[2fr_1fr]">
          {/* Parcel stream */}
          <div className="flex min-h-0 flex-col gap-3">
            {statusFilter ? (
              <div className="flex items-center gap-2 text-[12px] text-text-lo">
                Filtered to <StatusPill status={statusFilter} size="sm" />
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-text-hi"
                  onClick={() => setStatusFilter(null)}
                >
                  clear
                </button>
              </div>
            ) : null}
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              loading={parcels.isLoading}
              error={
                parcels.error
                  ? apiMessage(parcels.error, "The parcel stream is unavailable.")
                  : null
              }
              onRowClick={(row) => setOpenAwb(row.awb)}
              rowClassName={(row) => (flashed.has(row.id) ? "natex-flash" : undefined)}
              emptyTitle={debounced.trim() ? "No parcel matches that search" : "No parcels in scope"}
              emptyDescription={
                debounced.trim()
                  ? `Nothing matched "${debounced.trim()}" in AWB, consignee name or consignee phone for your branch.`
                  : statusFilter
                    ? `No parcel in your branch is currently ${humanise(statusFilter)}.`
                    : "Parcels booked against your branch appear here as soon as a merchant or the counter books them."
              }
              pagination={{
                page: parcels.data?.page ?? page,
                pageSize: parcels.data?.pageSize ?? 25,
                total: parcels.data?.total ?? 0,
                onPageChange: setPage,
              }}
              className="min-h-0 flex-1"
            />
          </div>

          {/* Counts + exception feed */}
          <div className="natex-scroll flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
            <div className="grid grid-cols-2 gap-3">
              <MetricTile label="In scope" value={total} />
              <MetricTile label="Awaiting pickup" value={booked} accent={GROUP_COLOUR.created} />
              <MetricTile label="In custody" value={inCustody} accent={GROUP_COLOUR.moving} />
              <MetricTile
                label="Exceptions"
                value={exceptions}
                accent={GROUP_COLOUR.warn}
                onClick={exceptions > 0 ? () => setStatusFilter("OnHold") : undefined}
              />
            </div>

            <section className="rounded-lg border border-border bg-card">
              <header className="border-b border-border px-4 py-3">
                <h2 className="label-xs text-muted-foreground">By status</h2>
              </header>
              <div className="p-2">
                {board.isLoading ? (
                  <div className="space-y-2 p-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div key={i} className="h-4 rounded bg-muted-foreground/15" aria-hidden />
                    ))}
                  </div>
                ) : board.error ? (
                  <ErrorNote className="m-2">
                    {apiMessage(board.error, "Counts are unavailable.")}
                  </ErrorNote>
                ) : counts.length === 0 ? (
                  <p className="p-3 text-[13px] text-muted-foreground">
                    No parcels in your branch scope yet.
                  </p>
                ) : (
                  counts.map((count) => (
                    <CountRow
                      key={count.status}
                      label={humanise(count.status)}
                      value={count.count}
                      colour={statusColour(count.status)}
                      active={statusFilter === count.status}
                      onClick={() =>
                        setStatusFilter(statusFilter === count.status ? null : count.status)
                      }
                    />
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card">
              <header className="flex items-center gap-2 border-b border-border px-4 py-3">
                <AlertTriangle className="size-3.5 text-status-warn" aria-hidden />
                <h2 className="label-xs text-muted-foreground">Exception feed</h2>
              </header>
              <div className="divide-y divide-border">
                {exceptionEvents.length === 0 ? (
                  <p className="px-4 py-5 text-[13px] text-muted-foreground">
                    No holds, failed attempts or losses recorded recently. This feed stays
                    empty when nothing needs chasing.
                  </p>
                ) : (
                  exceptionEvents.slice(0, 12).map((event) => (
                    <button
                      key={event.id}
                      type="button"
                      onClick={() => setOpenAwb(event.awb)}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-120 hover:bg-accent"
                    >
                      <span className="font-mono text-[12px] font-medium">{event.awb}</span>
                      <StatusPill status={event.toStatus} size="sm" className="ml-auto" />
                      <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
                        {since(event.ts)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-card">
              <header className="border-b border-border px-4 py-3">
                <h2 className="label-xs text-muted-foreground">Recent custody events</h2>
              </header>
              <div className="divide-y divide-border">
                {(board.data?.events ?? []).slice(0, 12).map((event) => (
                  <button
                    key={event.id}
                    type="button"
                    onClick={() => setOpenAwb(event.awb)}
                    className="flex w-full items-baseline gap-2 px-4 py-2 text-left transition-colors duration-120 hover:bg-accent"
                  >
                    <span className="font-mono text-[12px]">{event.awb}</span>
                    <span
                      className="text-[12px] font-medium"
                      style={{ color: statusColour(event.toStatus) }}
                    >
                      {humanise(event.toStatus)}
                    </span>
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {event.actorName ?? "System"} · {since(event.ts)}
                    </span>
                  </button>
                ))}
                {(board.data?.events ?? []).length === 0 && !board.isLoading ? (
                  <p className="px-4 py-5 text-[13px] text-muted-foreground">
                    No custody events yet.
                  </p>
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </div>

      <ParcelDrawer awb={openAwb} onOpenChange={(open) => !open && setOpenAwb(null)} />
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Remembers the status each row had on the previous poll so a row that just
 * moved gets the one-shot amber flash (design.md). Nothing loops: the class is
 * dropped after the animation window.
 */
function useStatusFlash(rows: { id: string; status: string }[]): Set<string> {
  const previous = React.useRef<Map<string, string>>(new Map());
  const [flashed, setFlashed] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    if (rows.length === 0) return;
    const changed = new Set<string>();
    for (const row of rows) {
      const before = previous.current.get(row.id);
      if (before && before !== row.status) changed.add(row.id);
      previous.current.set(row.id, row.status);
    }
    if (changed.size === 0) return;
    setFlashed(changed);
    const timer = setTimeout(() => setFlashed(new Set()), 1500);
    return () => clearTimeout(timer);
  }, [rows]);

  return flashed;
}
