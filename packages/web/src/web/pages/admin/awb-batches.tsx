import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, Page } from "@/components/natex/page";
import { DataTable, type Column } from "@/components/natex/data-table";
import { client, orpc, apiMessage } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";

type AwbBatchList = Awaited<ReturnType<typeof client.awbBatches.list>>;
type BatchRow = AwbBatchList["batches"][number];
type MerchantOption = AwbBatchList["merchants"][number];
type BatchExport = Awaited<ReturnType<typeof client.awbBatches.labels>>;

type ExportKind = "csv" | "pdf";
const EMPTY_BATCHES: BatchRow[] = [];
const EMPTY_MERCHANTS: MerchantOption[] = [];

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
  <p><strong>Batch:</strong> <span class="mono">${escapeHtml(batch.batchCode)}</span></p>
  <p><strong>Merchant:</strong> ${escapeHtml(batch.merchantName)}</p>
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
  const [merchantId, setMerchantId] = React.useState("");
  const [exporting, setExporting] = React.useState<{ id: string; kind: ExportKind } | null>(null);
  const [exportError, setExportError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const batchesQuery = useQuery(orpc.awbBatches.list.queryOptions());
  const batches = batchesQuery.data?.batches ?? EMPTY_BATCHES;
  const merchants = batchesQuery.data?.merchants ?? EMPTY_MERCHANTS;
  const selectedMerchant = merchants.find((merchant) => merchant.id === merchantId);

  React.useEffect(() => {
    if (merchantId && merchants.some((merchant) => merchant.id === merchantId && merchant.status === "active")) return;
    setMerchantId(merchants.find((merchant) => merchant.status === "active")?.id ?? "");
  }, [merchantId, merchants]);

  const createBatch = useMutation({
    mutationFn: (selectedMerchantId: string) => client.awbBatches.create({ merchantId: selectedMerchantId }),
    onSuccess: async (batch) => {
      setSuccess(`Batch ${batch.batchCode} created with 1,000 AWB labels for ${batch.merchantName}.`);
      await queryClient.invalidateQueries({ queryKey: orpc.awbBatches.list.key() });
    },
  });

  const totals = React.useMemo(() => {
    return merchants.map((merchant: MerchantOption) => {
      const owned = batches.filter((batch) => batch.merchantId === merchant.id);
      return {
        id: merchant.id,
        name: merchant.name,
        batchCount: owned.length,
        issued: owned.reduce((sum, batch) => sum + batch.labelCount, 0),
        used: owned.reduce((sum, batch) => sum + batch.usedCount, 0),
        unused: owned.reduce((sum, batch) => sum + batch.unusedCount, 0),
      };
    });
  }, [batches, merchants]);

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
          `natex-${batch.batchCode}-unused-awbs.csv`,
          ["AWB", "Batch ID", "Merchant", "Usage"],
          unused.map((label) => [label.awb, batch.batchCode, batch.merchantName, "Unused — not booked"]),
        );
      } else if (popup) {
        openPrintableBatch(popup, data, unused);
      }
      setSuccess(`${unused.length} unused label${unused.length === 1 ? "" : "s"} ready from ${batch.batchCode}.`);
    } catch (error) {
      popup?.close();
      setExportError(apiMessage(error, "The label export failed."));
    } finally {
      setExporting(null);
    }
  };

  const columns: Column<BatchRow>[] = [
    {
      key: "batch",
      header: "Batch identity",
      width: "w-[190px]",
      cell: (row) => <span className="font-mono font-semibold">{row.batchCode}</span>,
    },
    {
      key: "merchant",
      header: "Merchant",
      cell: (row) => <span className="font-medium">{row.merchantName}</span>,
    },
    {
      key: "range",
      header: "AWB range",
      width: "w-[250px]",
      cell: (row) => <span className="font-mono text-[12px]">{row.awbStart} – {row.awbEnd}</span>,
    },
    {
      key: "used",
      header: "Used",
      align: "right",
      width: "w-[90px]",
      className: "font-mono",
      cell: (row) => row.usedCount.toLocaleString(),
    },
    {
      key: "unused",
      header: "Unused stickers",
      align: "right",
      width: "w-[140px]",
      className: "font-mono font-semibold",
      cell: (row) => row.unusedCount.toLocaleString(),
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
      description="Issue fixed 1,000-number AWB series to merchants, export the unused stickers for a preprint manufacturer, and monitor how many have been booked."
    >
      <Card title="Generate a batch" description="Every batch contains exactly 1,000 sequential, globally reserved NX AWBs.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Assign batch to merchant" hint="Only active merchants can be issued a new batch." className="w-full max-w-md">
            <Select value={merchantId} onChange={(event) => setMerchantId(event.target.value)} disabled={!merchants.length}>
              <option value="">Select a merchant</option>
              {merchants.map((merchant: MerchantOption) => (
                <option key={merchant.id} value={merchant.id} disabled={merchant.status !== "active"}>
                  {merchant.name}{merchant.status !== "active" ? ` — ${merchant.status}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            pending={createBatch.isPending}
            disabled={!merchantId || selectedMerchant?.status !== "active" || createBatch.isPending}
            onClick={() => {
              setSuccess(null);
              createBatch.mutate(merchantId);
            }}
          >
            <Plus aria-hidden />
            Create 1,000-label batch
          </Button>
        </div>
        <p className="mt-3 max-w-3xl text-[12px] leading-relaxed text-muted-foreground">
          Bookings for that merchant automatically consume the next unused AWB in its series. AWBs are globally reserved, and the batch cannot be reassigned.
        </p>
        {createBatch.error ? <p role="alert" className="mt-3 text-[13px] text-status-bad">{apiMessage(createBatch.error, "The batch could not be created.")}</p> : null}
        {success ? <output aria-live="polite" className="mt-3 block text-[13px] text-status-good">{success}</output> : null}
      </Card>

      <Card title="Unused stickers by merchant" description="Unused means the AWB has not yet been attached to a booked parcel; the system does not track whether a sticker has already been physically printed.">
        {totals.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {totals.map((merchant) => (
              <div key={merchant.id} className="rounded-md border border-border bg-background p-4">
                <h3 className="truncate text-[14px] font-semibold">{merchant.name}</h3>
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-muted-foreground">Unused stickers</span>
                  <span className="font-mono text-[20px] font-bold">{merchant.unused.toLocaleString()}</span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {merchant.used.toLocaleString()} used · {merchant.issued.toLocaleString()} issued · {merchant.batchCount} batch{merchant.batchCount === 1 ? "" : "es"}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">Merchant balances will appear after the list loads. No label batches have been issued yet.</p>
        )}
      </Card>

      <Card title="Batch register" description="Export includes only currently unused AWBs. CSV opens in Excel; PDF opens the browser print dialog, where it can be saved as a PDF.">
        {exportError ? <p role="alert" className="mb-3 text-[13px] text-status-bad">{exportError}</p> : null}
        <DataTable
          columns={columns}
          rows={batches}
          rowKey={(row) => row.id}
          loading={batchesQuery.isLoading}
          error={batchesQuery.error ? apiMessage(batchesQuery.error, "The batch register is unavailable.") : null}
          emptyTitle="No AWB batch has been issued"
          emptyDescription="Generate a batch above to reserve 1,000 consecutive AWB stickers for a merchant."
        />
      </Card>
    </Page>
  );
}
