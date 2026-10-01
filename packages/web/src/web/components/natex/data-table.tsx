import * as React from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * DataTable — design.md: "one component for every list across all four
 * portals. Props: columns, pagination, filters, empty state."
 *
 * Sticky header, zebra off, hover row tint, server-side pagination footer with
 * row count. The staggered load reveal is applied here (capped at 12 rows) so
 * every list in the product animates identically and exactly once.
 */

export interface Column<T> {
  /** Stable key — also the header cell key. */
  key: string;
  header: React.ReactNode;
  cell: (row: T, index: number) => React.ReactNode;
  /** Tailwind width class, e.g. "w-[140px]". */
  width?: string;
  align?: "left" | "right" | "center";
  /** Money and ids: right-aligned mono (design.md). */
  className?: string;
  headerClassName?: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  pagination,
  filters,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  onRowClick,
  rowClassName,
  dense = false,
  className,
  reveal = true,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  loading?: boolean;
  /** Plain-language message; never a raw status code (design.md). */
  error?: string | null;
  pagination?: Pagination;
  /** Filter controls rendered in the bar above the table. */
  filters?: React.ReactNode;
  emptyTitle?: string;
  /** Empty state must state the reason, not just "no data" (design.md). */
  emptyDescription?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  dense?: boolean;
  className?: string;
  reveal?: boolean;
}) {
  const totalPages = pagination
    ? Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.pageSize)))
    : 1;

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      {filters ? (
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          {filters}
        </div>
      ) : null}

      <div className="natex-scroll min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    "label-xs border-b border-border px-4 py-2.5 text-muted-foreground",
                    column.align === "right" && "text-right",
                    column.align === "center" && "text-center",
                    column.width,
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <LoadingRows columns={columns} dense={dense} />
            ) : error ? (
              <tr>
                <td
                  colSpan={columns.length}
                  aria-label="This list could not be loaded"
                  className="px-4 py-12 text-center"
                >
                  <p className="text-[14px] font-semibold text-status-warn">
                    This list could not be loaded
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
                    {error}
                  </p>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-14 text-center">
                  <Inbox
                    className="mx-auto mb-2 size-6 text-muted-foreground/60"
                    aria-hidden
                  />
                  <p className="text-[14px] font-semibold">{emptyTitle}</p>
                  {emptyDescription ? (
                    <p className="mx-auto mt-1 max-w-md text-[13px] text-muted-foreground">
                      {emptyDescription}
                    </p>
                  ) : null}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={rowKey(row, index)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  style={
                    reveal
                      ? ({ "--row-delay": `${Math.min(index, 12) * 24}ms` } as React.CSSProperties)
                      : undefined
                  }
                  className={cn(
                    "border-b border-border transition-colors duration-120 last:border-b-0",
                    "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    onRowClick && "cursor-pointer",
                    reveal && "natex-reveal",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "px-4 align-middle text-[13px] leading-[1.35]",
                        dense ? "h-10" : "h-11",
                        column.align === "right" && "text-right",
                        column.align === "center" && "text-center",
                        column.className,
                      )}
                    >
                      {column.cell(row, index)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pagination ? (
        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-4 py-2.5">
          <p className="text-[12px] text-muted-foreground">
            {pagination.total === 0 ? (
              "0 rows"
            ) : (
              <>
                <span className="font-mono text-foreground">
                  {(pagination.page - 1) * pagination.pageSize + 1}–
                  {Math.min(pagination.page * pagination.pageSize, pagination.total)}
                </span>{" "}
                of <span className="font-mono text-foreground">{pagination.total}</span> rows
              </>
            )}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted-foreground">
              Page <span className="font-mono text-foreground">{pagination.page}</span> /{" "}
              <span className="font-mono text-foreground">{totalPages}</span>
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Previous page"
              disabled={pagination.page <= 1 || loading}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Next page"
              disabled={pagination.page >= totalPages || loading}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Static skeleton cells — design.md forbids a pulsing loader. */
function LoadingRows<T>({ columns, dense }: { columns: Column<T>[]; dense: boolean }) {
  const widths = ["w-24", "w-16", "w-32", "w-20", "w-28", "w-14"];
  return (
    <>
      {Array.from({ length: 8 }).map((_, r) => (
        <tr key={r} aria-hidden className="border-b border-border last:border-b-0">
          {columns.map((column, c) => (
            <td
              key={column.key}
              aria-label="Loading"
              className={cn("px-4", dense ? "h-10" : "h-11")}
            >
              <div
                aria-hidden
                className={cn("h-3 rounded-md bg-muted-foreground/15", widths[(r + c) % widths.length])}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Mono cell used for AWBs, seals, UTRs and device ids (design.md). */
export function MonoCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("font-mono text-[13px] font-medium", className)}>{children}</span>
  );
}
