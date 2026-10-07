import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Layers, Printer, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, Page } from "@/components/natex/page";
import { DataTable, type Column } from "@/components/natex/data-table";
import { client, orpc, apiMessage } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { awbRangeMatchesQuery } from "./awb-batch-search";

type AwbBatchList = Awaited<ReturnType<typeof client.awbBatches.list>>;
type BatchRow = AwbBatchList["batches"][number];
type MerchantOption = AwbBatchList["merchants"][number];
type LocationOption = AwbBatchList["locations"][number];
type BatchExport = Awaited<ReturnType<typeof client.awbBatches.labels>>;
type AssigneeType = "merchant" | "branch" | "hub";

type InventoryRow = {
  id: string;
  name: string;
  type: string;
  batchCount: number;
  issued: number;
  used: number;
  unused: number;
};

type ExportKind = "csv" | "pdf";
const EMPTY_BATCHES: BatchRow[] = [];
const EMPTY_MERCHANTS: MerchantOption[] = [];
const EMPTY_LOCATIONS: LocationOption[] = [];

function dateTime(value: string | Date): string {
  return new Date(value).toLocaleString("en-LK", {
    timeZone: "Asia/Colombo",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function assigneeTypeLabel(type: string | null): string {
  if (type === "merchant") return "Merchant";
  if (type === "branch") return "Branch";
  if (type === "hub") return "Hub";
  return "Planned / unassigned";
}

function formatSeriesId(seriesNumber: number): string {
  return `S-${String(seriesNumber).padStart(6, "0")}`;
}

function openPrintableBatch(popup: Window, data: BatchExport, unused: BatchExport["labels"]): void {
  const batch = data.batch;
  const items = unused
    .map((label) => `<li>${escapeHtml(label.awb)}</li>`)
    .join("");
  popup.opener = null;
  popup.document.open();
  popup.document.write(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(batch.batchCode)} — AWB stickers</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { color: #111827; font: 12px Arial, sans-serif; margin: 0; }
  header { border-bottom: 2px solid #111827; margin-bottom: 12px; padding-bottom: 8px; }
  h1 { font-size: 19px; margin: 0 0 8px; }
  p { margin: 3px 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  ol { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; list-style: none; margin: 0; padding: 0; }
  li { border: 1px solid #9ca3af; border-radius: 3px; font: 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 5px 4px; text-align: center; break-inside: avoid; }
  .empty { border: 1px solid #9ca3af; padding: 14px; }
  @media screen { body { margin: 20px auto; max-width: 900px; padding: 18px; } }
</style>
</head>
<body>
<header>
  <h1>NatEx — AWB sticker series</h1>
  <p><strong>Series ID:</strong> <span class="mono">${escapeHtml(formatSeriesId(batch.seriesNumber))}</span></p>
  <p><strong>Batch:</strong> <span class="mono">${escapeHtml(batch.batchCode)}</span></p>
  <p><strong>Status:</strong> ${escapeHtml(batch.status)}</p>
  <p><strong>Assigned to:</strong> ${escapeHtml(batch.assigneeName ?? "Planned / unassigned")}</p>
  ${batch.assignedAt ? `<p><strong>Assigned by / at:</strong> ${escapeHtml(batch.assignedByName ?? "Admin")} · ${escapeHtml(dateTime(batch.assignedAt))}</p>` : ""}
  <p><strong>Range:</strong> <span class="mono">${escapeHtml(batch.awbStart)} — ${escapeHtml(batch.awbEnd)}</span></p>
  <p><strong>Unused at export:</strong> ${unused.length} of ${batch.labelCount} labels</p>
  <p><strong>Generated:</strong> ${escapeHtml(dateTime(batch.createdAt))}</p>
</header>
${unused.length ? `<ol>${items}</ol>` : '<p class="empty">All labels in this batch have been used for bookings.</p>'}
</body>
</html>`);
  popup.document.close();
  popup.focus();
  window.setTimeout(() => popup.print(), 250);
}

export default function AdminAwbBatches() {
  const queryClient = useQueryClient();
  const [batchCount, setBatchCount] = React.useState("1");
  const [assignmentBatchId, setAssignmentBatchId] = React.useState("");
  const [assigneeType, setAssigneeType] = React.useState<AssigneeType>("merchant");
  const [assigneeId, setAssigneeId] = React.useState("");
  const [exporting, setExporting] = React.useState<{ id: string; kind: ExportKind } | null>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [seriesSearch, setSeriesSearch] = React.useState("");
  const batchesQuery = useQuery(orpc.awbBatches.list.queryOptions());
  const batches = batchesQuery.data?.batches ?? EMPTY_BATCHES;
  const visibleBatches = React.useMemo(() => {
    const term = seriesSearch.trim().toLowerCase();
    if (!term) return batches;
    return batches.filter((batch) => {
      const identity = [
        formatSeriesId(batch.seriesNumber),
        String(batch.seriesNumber),
        batch.batchCode,
        batch.awbStart,
        batch.awbEnd,
        batch.merchantId,
        batch.merchantName,
        batch.assigneeId ?? "",
        batch.assigneeName ?? "",
      ].join(" ").toLowerCase();
      return identity.includes(term) || awbRangeMatchesQuery(term, batch.awbStart, batch.awbEnd);
    });
  }, [batches, seriesSearch]);
  const merchants = batchesQuery.data?.merchants ?? EMPTY_MERCHANTS;
  const locations = batchesQuery.data?.locations ?? EMPTY_LOCATIONS;
  const batchCountValue = Number(batchCount);
  const validBatchCount = Number.isInteger(batchCountValue) && batchCountValue >= 1 && batchCountValue <= 50;
  const plannedBatches = React.useMemo(() => batches.filter((batch) => batch.status === "planned"), [batches]);
  const availableTargets = React.useMemo(() => {
    if (assigneeType === "merchant") {
      return merchants.filter((merchant) => merchant.status === "active").map(({ id, name }) => ({ id, name }));
    }
    return locations
      .filter((location) => location.type === assigneeType)
      .map(({ id, name }) => ({ id, name }));
  }, [assigneeType, locations, merchants]);

  React.useEffect(() => {
    if (assignmentBatchId && plannedBatches.some((batch) => batch.id === assignmentBatchId)) return;
    setAssignmentBatchId(plannedBatches[0]?.id ?? "");
  }, [assignmentBatchId, plannedBatches]);

  React.useEffect(() => {
    if (assigneeId && availableTargets.some((target) => target.id === assigneeId)) return;
    setAssigneeId(availableTargets[0]?.id ?? "");
  }, [assigneeId, availableTargets]);

  const generateBatches = useMutation({
    mutationFn: (count: number) => client.awbBatches.generate({ count }),
    onSuccess: async (created) => {
      const labels = created.length * 1_000;
      const firstSeries = created[0]?.seriesNumber;
      const lastSeries = created.at(-1)?.seriesNumber;
      const ids = firstSeries && lastSeries ? ` Series IDs ${formatSeriesId(firstSeries)}–${formatSeriesId(lastSeries)}.` : "";
      setSuccess(`Generated ${created.length} planned batch${created.length === 1 ? "" : "es"} (${labels.toLocaleString()} AWB labels).${ids} Assign each batch when it is ready to issue.`);
      await queryClient.invalidateQueries({ queryKey: orpc.awbBatches.list.key() });
    },
  });

  const assignBatch = useMutation({
    mutationFn: () => client.awbBatches.assign({ batchId: assignmentBatchId, assigneeType, assigneeId }),
    onSuccess: async (batch) => {
      setSuccess(`${formatSeriesId(batch.seriesNumber)} (${batch.batchCode}) assigned to ${assigneeTypeLabel(batch.assigneeType)} · ${batch.assigneeName}.`);
      await queryClient.invalidateQueries({ queryKey: orpc.awbBatches.list.key() });
    },
  });

  const inventory = React.useMemo(() => {
    const rows: InventoryRow[] = [];
    const planned = batches.filter((batch) => batch.status === "planned");
    if (planned.length) {
      rows.push({
        id: "planned",
        name: "Planned / unassigned",
        type: "Planned",
        batchCount: planned.length,
        issued: planned.reduce((sum, batch) => sum + batch.labelCount, 0),
        used: planned.reduce((sum, batch) => sum + batch.usedCount, 0),
        unused: planned.reduce((sum, batch) => sum + batch.unusedCount, 0),
      });
    }

    const targets: { id: string; name: string; type: AssigneeType }[] = [
      ...merchants.map((merchant) => ({ id: merchant.id, name: merchant.name, type: "merchant" as const })),
      ...locations.map((location) => ({ id: location.id, name: location.name, type: location.type as AssigneeType })),
    ];
    for (const target of targets) {
      const owned = batches.filter((batch) => batch.assigneeType === target.type && batch.assigneeId === target.id);
      if (!owned.length) continue;
      rows.push({
        id: `${target.type}:${target.id}`,
        name: target.name,
        type: assigneeTypeLabel(target.type),
        batchCount: owned.length,
        issued: owned.reduce((sum, batch) => sum + batch.labelCount, 0),
        used: owned.reduce((sum, batch) => sum + batch.usedCount, 0),
        unused: owned.reduce((sum, batch) => sum + batch.unusedCount, 0),
      });
    }
    return rows;
  }, [batches, locations, merchants]);

  const exportBatch = async (batch: BatchRow, kind: ExportKind) => {
    setExportError(null);
    setExporting({ id: batch.id, kind });
    // Open synchronously from the click handler so browsers don't block the
    // print/PDF window while the authorized label details are being fetched.
    const popup = kind === "pdf" ? window.open("about:blank", "_blank") : null;
    if (kind === "pdf" && !popup) {
      setExportError("Allow pop-ups for NatEx to open the print / Save as PDF view.");
      setExporting(null);
      return;
    }
    try {
      const data = await client.awbBatches.labels({ batchId: batch.id });
      const unused = data.labels.filter((label) => !label.used);
      if (kind === "csv") {
        downloadCsv(
          `natex-${formatSeriesId(batch.seriesNumber)}-${batch.batchCode}-unused-awbs.csv`,
          ["AWB", "Series ID", "Batch code", "AWB series range", "Assignment type", "Assigned to", "Usage"],
          unused.map((label) => [
            label.awb,
            formatSeriesId(batch.seriesNumber),
            batch.batchCode,
            `${batch.awbStart} – ${batch.awbEnd}`,
            assigneeTypeLabel(batch.assigneeType),
            batch.assigneeName ?? "Planned / unassigned",
            "Unused — not booked",
          ]),
        );
      } else if (popup) {
        openPrintableBatch(popup, data, unused);
      }
      setSuccess(`${unused.length} unused label${unused.length === 1 ? "" : "s"} ready from ${formatSeriesId(batch.seriesNumber)} (${batch.batchCode}).`);
    } catch (error) {
      popup?.close();
      setExportError(apiMessage(error, "The label export failed."));
    } finally {
      setExporting(null);
    }
  };

  const columns: Column<BatchRow>[] = [
    {
      key: "seriesId",
      header: "Series ID",
      width: "w-[120px]",
      cell: (row) => <span className="font-mono font-semibold">{formatSeriesId(row.seriesNumber)}</span>,
    },
    {
      key: "range",
      header: "AWB series range",
      width: "w-[270px]",
      cell: (row) => <span className="font-mono text-[12px]">{row.awbStart} – {row.awbEnd}</span>,
    },
    {
      key: "batchCode",
      header: "Batch code",
      width: "w-[190px]",
      cell: (row) => <span className="font-mono font-semibold">{row.batchCode}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "w-[130px]",
      cell: (row) => <span className={row.status === "planned" ? "font-medium text-status-warn" : "font-medium"}>{row.status}</span>,
    },
    {
      key: "assignee",
      header: "Assigned to",
      width: "w-[260px]",
      cell: (row) => (
        <span>
          {row.assigneeName ?? "Planned / unassigned"}
          {row.assigneeType ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{assigneeTypeLabel(row.assigneeType)}</span> : null}
          {row.assignedAt ? <span className="mt-0.5 block text-[11px] text-muted-foreground">Assigned by {row.assignedByName ?? "Admin"} · {dateTime(row.assignedAt)}</span> : null}
        </span>
      ),
    },
    {
      key: "used",
      header: "Used / unused",
      align: "right",
      width: "w-[145px]",
      className: "font-mono",
      cell: (row) => `${row.usedCount.toLocaleString()} / ${row.unusedCount.toLocaleString()}`,
    },
    {
      key: "created",
      header: "Created by / date",
      width: "w-[190px]",
      cell: (row) => (
        <span>
          {row.createdByName}
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{dateTime(row.createdAt)}</span>
        </span>
      ),
    },
    {
      key: "export",
      header: "Export remaining",
      width: "w-[230px]",
      cell: (row) => (
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            pending={exporting?.id === row.id && exporting.kind === "csv"}
            disabled={exporting !== null || row.unusedCount === 0}
            onClick={() => void exportBatch(row, "csv")}
            aria-label={`Download unused AWBs for ${row.batchCode} as Excel-compatible CSV`}
          >
            <Download aria-hidden />
            Excel CSV
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            pending={exporting?.id === row.id && exporting.kind === "pdf"}
            disabled={exporting !== null || row.unusedCount === 0}
            onClick={() => void exportBatch(row, "pdf")}
            aria-label={`Print or save unused AWBs for ${row.batchCode} as PDF`}
          >
            <Printer aria-hidden />
            PDF
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Page
      title="AWB label batches"
      description="Generate planned 1,000-label batches, assign them to merchants or locations, and track the unused stock as bookings consume AWBs."
    >
      <Card title="Generate new batches" description="Each batch contains exactly 1,000 sequential, globally reserved NX AWBs. Generated batches start as planned and unassigned.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Number of batches" hint="Generate 1–50 batches at a time.">
            <Input
              type="number"
              min={1}
              max={50}
              step={1}
              value={batchCount}
              onChange={(event) => setBatchCount(event.target.value)}
              className="w-40"
            />
          </Field>
          <Button
            type="button"
            pending={generateBatches.isPending}
            disabled={!validBatchCount || generateBatches.isPending}
            onClick={() => {
              setSuccess(null);
              generateBatches.mutate(batchCountValue);
            }}
          >
            <Layers aria-hidden />
            Generate {validBatchCount ? `${batchCountValue} batch${batchCountValue === 1 ? "" : "es"}` : "batches"}
          </Button>
        </div>
        {generateBatches.error ? <p role="alert" className="mt-3 text-[13px] text-status-bad">{apiMessage(generateBatches.error, "The batches could not be generated.")}</p> : null}
        <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
          For example, generating 10 batches reserves 10,000 unique AWB numbers. Assign each planned batch to a merchant, branch, or hub when it is ready to issue.
        </p>
      </Card>

      <Card title="Assign batch" description="Select a planned batch and assign its full 1,000-label range to one merchant, branch, or hub.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Planned batch" className="w-full max-w-sm">
            <Select value={assignmentBatchId} onChange={(event) => setAssignmentBatchId(event.target.value)} disabled={!plannedBatches.length}>
              <option value="">{plannedBatches.length ? "Select a planned batch" : "No planned batches available"}</option>
              {plannedBatches.map((batch) => (
                <option key={batch.id} value={batch.id}>{formatSeriesId(batch.seriesNumber)} · {batch.awbStart}–{batch.awbEnd}</option>
              ))}
            </Select>
          </Field>
          <Field label="Assign to type" className="w-40">
            <Select value={assigneeType} onChange={(event) => setAssigneeType(event.target.value as AssigneeType)}>
              <option value="merchant">Merchant</option>
              <option value="branch">Branch</option>
              <option value="hub">Hub</option>
            </Select>
          </Field>
          <Field label={assigneeTypeLabel(assigneeType)} className="w-full max-w-sm">
            <Select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} disabled={!availableTargets.length}>
              <option value="">{availableTargets.length ? `Select a ${assigneeType}` : `No ${assigneeType}s available`}</option>
              {availableTargets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </Select>
          </Field>
          <Button
            type="button"
            pending={assignBatch.isPending}
            disabled={!assignmentBatchId || !assigneeId || assignBatch.isPending}
            onClick={() => {
              setSuccess(null);
              assignBatch.mutate();
            }}
          >
            <UserPlus aria-hidden />
            Assign batch
          </Button>
        </div>
        {assignBatch.error ? <p role="alert" className="mt-3 text-[13px] text-status-bad">{apiMessage(assignBatch.error, "The batch could not be assigned.")}</p> : null}
        <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
          Merchant batches are consumed first for that merchant&apos;s bookings. If no merchant labels remain, bookings at an assigned branch or hub use that location&apos;s stock.
        </p>
      </Card>

      {success ? <output aria-live="polite" className="block text-[13px] text-status-good">{success}</output> : null}

      <Card title="Unused stickers by assignee" description="Counts reflect AWBs not yet attached to booked parcels. Planned batches remain in central stock until assigned.">
        {inventory.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {inventory.map((owner) => (
              <div key={owner.id} className="rounded-md border border-border bg-background p-4">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{owner.type}</span>
                <h3 className="mt-1 truncate text-[14px] font-semibold">{owner.name}</h3>
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-muted-foreground">Unused stickers</span>
                  <span className="font-mono text-[20px] font-bold">{owner.unused.toLocaleString()}</span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {owner.used.toLocaleString()} used · {owner.issued.toLocaleString()} issued · {owner.batchCount} batch{owner.batchCount === 1 ? "" : "es"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No AWB batches have been generated yet.</p>
        )}
      </Card>

      <Card title="Batch register" description="Track every batch from planned to assigned or depleted. Export includes only currently unused AWBs; CSV opens in Excel and PDF opens the browser print dialog.">
        {exportError ? <p role="alert" className="mb-3 text-[13px] text-status-bad">{exportError}</p> : null}
        <div className="mb-3 max-w-lg">
          <Field label="Search batch / AWB / merchant" hint="Search by series ID, batch code, any AWB within the range, or merchant/assignee.">
            <Input
              type="search"
              value={seriesSearch}
              onChange={(event) => setSeriesSearch(event.target.value)}
              placeholder="e.g. NXB-…, NX1234567890, or merchant name"
            />
          </Field>
        </div>
        <DataTable
          columns={columns}
          rows={visibleBatches}
          rowKey={(row) => row.id}
          loading={batchesQuery.isLoading}
          error={batchesQuery.error ? apiMessage(batchesQuery.error, "The batch register is unavailable.") : null}
          emptyTitle={seriesSearch.trim() ? "No matching AWB series" : "No AWB batch has been generated"}
          emptyDescription={seriesSearch.trim() ? "Try a series ID, range endpoint, batch code, or assignee name." : "Generate one or more 1,000-label batches above. They will appear as planned until assigned."}
        />
      </Card>
    </Page>
  );
}
