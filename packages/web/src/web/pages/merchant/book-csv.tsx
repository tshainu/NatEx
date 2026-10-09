import * as React from "react";
import { Link } from "wouter";
import { CheckCircle2, Download, FileUp, RotateCcw } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { apiMessage, client } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { money } from "@/lib/format";
import {
  chunk,
  FIELD_TO_HEADER,
  prepareBulkCsv,
  TEMPLATE_COLUMNS,
  TEMPLATE_EXAMPLE,
  TEMPLATE_HEADER,
  type PreparedFile,
} from "@/lib/bulk-csv";
import { Card, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { MetricTile } from "@/components/natex/metric-tile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { bulkChunk, useInvalidateParcels, type BulkReport } from "@/queries/merchant";

/**
 * Bulk CSV booking. Three steps, none of which books anything until the last:
 *
 *  1. Parse in the browser (`prepareBulkCsv`): column mapping, rupees → cents
 *     and kg → grams by string arithmetic, whole-file duplicate refs.
 *  2. Check with NatEx: every locally valid row goes to `bulkCreate` with
 *     `dryRun: true`, in chunks of CHUNK — the server's own validation, with
 *     nothing written.
 *  3. Book: the rows that passed both, in the same chunks. Each chunk carries
 *     its own Idempotency-Key, minted once and kept, so "Retry failed chunks"
 *     replays a chunk that timed out instead of booking it twice (§4).
 */

/** Mirrors the server's BULK_ROW_LIMIT; the server enforces it regardless. */
const CHUNK = 100;
const PAGE = 25;

type RowState = "local_error" | "unchecked" | "ok" | "rejected" | "booked" | "failed";

interface ViewRow {
  line: number;
  ref: string;
  name: string;
  cod: number;
  state: RowState;
  messages: string[];
  awb: string | null;
}

interface ChunkRun {
  lines: number[];
  key: string;
  status: "pending" | "done" | "failed";
  error?: string;
}

export function BulkUpload({ codEnabled }: { codEnabled: boolean }) {
  const merchantId = useAuth().session!.user.merchantId;
  const invalidate = useInvalidateParcels();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = React.useState<string | null>(null);
  const [prepared, setPrepared] = React.useState<PreparedFile | null>(null);
  const [server, setServer] = React.useState<Map<number, { ok: boolean; messages: string[] }>>(new Map());
  const [booked, setBooked] = React.useState<Map<number, string>>(new Map());
  const [chunks, setChunks] = React.useState<ChunkRun[]>([]);
  const [phase, setPhase] = React.useState<"idle" | "checking" | "checked" | "booking" | "done">("idle");
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [onlyProblems, setOnlyProblems] = React.useState(false);

  const reset = () => {
    setPrepared(null);
    setFileName(null);
    setServer(new Map());
    setBooked(new Map());
    setChunks([]);
    setPhase("idle");
    setError(null);
    setPage(1);
    setOnlyProblems(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onFile = async (file: File | undefined) => {
    reset();
    if (!file) return;
    setFileName(file.name);
    if (file.size > 5 * 1024 * 1024) {
      setError("That file is over 5 MB. Split it into smaller files.");
      return;
    }
    const text = await file.text();
    const p = prepareBulkCsv(text);
    if (!codEnabled) {
      for (const r of p.rows) {
        if (r.payload && (r.payload.codAmountCents as number) > 0) {
          r.errors.push({ field: "cod_rs", message: "Your account is prepaid only — COD must be blank" });
          r.payload = null;
        }
      }
    }
    setPrepared(p);
  };

  const rows: ViewRow[] = React.useMemo(() => {
    if (!prepared) return [];
    return prepared.rows.map((r) => {
      const s = server.get(r.line);
      const awb = booked.get(r.line) ?? null;
      let state: RowState = r.payload ? "unchecked" : "local_error";
      let messages = r.errors.map((e) => `${e.field}: ${e.message}`);
      if (r.payload && s) {
        state = s.ok ? "ok" : "rejected";
        messages = s.messages;
      }
      if (awb) state = "booked";
      return {
        line: r.line,
        ref: r.source.order_ref ?? "",
        name: r.source.consignee_name ?? "",
        cod: (r.payload?.codAmountCents as number | undefined) ?? 0,
        state,
        messages,
        awb,
      };
    });
  }, [prepared, server, booked]);

  // Rows in a chunk that failed outright are shown as failed, not as booked.
  const failedLines = new Set(chunks.filter((c) => c.status === "failed").flatMap((c) => c.lines));
  const view = rows.map((r) => (failedLines.has(r.line) && r.state === "ok" ? { ...r, state: "failed" as const } : r));

  const tally = {
    total: view.length,
    ok: view.filter((r) => r.state === "ok" || r.state === "unchecked").length,
    bad: view.filter((r) => r.state === "local_error" || r.state === "rejected").length,
    booked: view.filter((r) => r.state === "booked").length,
    failed: view.filter((r) => r.state === "failed").length,
    codCents: view.filter((r) => r.state === "ok" || r.state === "booked").reduce((s, r) => s + r.cod, 0),
  };

  const sendable = (prepared?.rows ?? []).filter((r) => r.payload);

  const absorb = (report: BulkReport, into: Map<number, { ok: boolean; messages: string[] }>) => {
    for (const a of report.accepted) into.set(a.line, { ok: true, messages: [] });
    for (const r of report.rejected) {
      into.set(r.line, {
        ok: false,
        messages: r.errors.map((e) => `${FIELD_TO_HEADER[e.field] ?? e.field}: ${e.message}`),
      });
    }
  };

  const check = async () => {
    if (!merchantId) return setError("This login is not linked to a merchant account.");
    setError(null);
    setPhase("checking");
    const next = new Map<number, { ok: boolean; messages: string[] }>();
    try {
      for (const part of chunk(sendable, CHUNK)) {
        const awbs = part.map((r) => String(r.payload!.awb));
        const checks = await client.awbBatches.checkMany({ awbs });
        const eligible = new Set<number>();
        checks.forEach((check, index) => {
          const row = part[index]!;
          if (check.valid) eligible.add(row.line);
          else next.set(row.line, { ok: false, messages: [`awb: ${check.reason}`] });
        });
        const validRows = part.filter((row) => eligible.has(row.line));
        if (validRows.length) {
          const report = await bulkChunk(
            { merchantId, dryRun: true, rows: validRows.map((r) => r.payload!) },
            crypto.randomUUID(),
          );
          absorb(report, next);
        }
        setServer(new Map(next));
      }
      setPhase("checked");
    } catch (err) {
      setError(apiMessage(err, "NatEx could not check this file. Nothing was booked."));
      setPhase("idle");
    }
  };

  const runChunks = async (plan: ChunkRun[]) => {
    if (!merchantId) return;
    setPhase("booking");
    setError(null);
    const byLine = new Map(sendable.map((r) => [r.line, r.payload!]));
    const nextBooked = new Map(booked);
    const nextServer = new Map(server);
    const state = [...plan];
    for (let i = 0; i < state.length; i += 1) {
      const c = state[i]!;
      if (c.status === "done") continue;
      try {
        const report = await bulkChunk(
          { merchantId, dryRun: false, rows: c.lines.map((l) => byLine.get(l)!) },
          c.key,
        );
        absorb(report, nextServer);
        for (const a of report.accepted) if (a.awb) nextBooked.set(a.line, a.awb);
        state[i] = { ...c, status: "done", error: undefined };
      } catch (err) {
        state[i] = { ...c, status: "failed", error: apiMessage(err, "This chunk did not reach NatEx.") };
      }
      setChunks([...state]);
      setBooked(new Map(nextBooked));
      setServer(new Map(nextServer));
    }
    setPhase("done");
    void invalidate();
  };

  const book = () => {
    const okLines = sendable.filter((r) => server.get(r.line)?.ok).map((r) => r.line);
    const plan = chunk(okLines, CHUNK).map((lines) => ({
      lines,
      key: crypto.randomUUID(),
      status: "pending" as const,
    }));
    setChunks(plan);
    void runChunks(plan);
  };

  const downloadErrors = () => {
    const bad = new Set(view.filter((r) => r.state === "local_error" || r.state === "rejected" || r.state === "failed").map((r) => r.line));
    const msgs = new Map(view.map((r) => [r.line, r.messages.join("; ") || (r.state === "failed" ? "Not booked — retry" : "")]));
    downloadCsv(
      `${(fileName ?? "bookings").replace(/\.csv$/i, "")}-errors.csv`,
      ["line", ...TEMPLATE_HEADER, "errors"],
      (prepared?.rows ?? [])
        .filter((r) => bad.has(r.line))
        .map((r) => [r.line, ...TEMPLATE_HEADER.map((h) => r.source[h] ?? ""), msgs.get(r.line) ?? ""]),
    );
  };

  const downloadResults = () => {
    downloadCsv(
      `${(fileName ?? "bookings").replace(/\.csv$/i, "")}-awbs.csv`,
      ["line", "order_ref", "consignee_name", "awb", "result", "errors"],
      view.map((r) => [r.line, r.ref, r.name, r.awb ?? "", r.state, r.messages.join("; ")]),
    );
  };

  const shown = onlyProblems ? view.filter((r) => r.state !== "ok" && r.state !== "booked" && r.state !== "unchecked") : view;
  const pageRows = shown.slice((page - 1) * PAGE, page * PAGE);

  const columns: Column<ViewRow>[] = [
    { key: "line", header: "Line", width: "w-[70px]", className: "font-mono text-muted-foreground", cell: (r) => r.line },
    { key: "ref", header: "Order ref", width: "w-[130px]", cell: (r) => <MonoCell>{r.ref || "—"}</MonoCell> },
    { key: "name", header: "Consignee", cell: (r) => r.name || "—" },
    {
      key: "cod",
      header: "COD",
      align: "right",
      width: "w-[110px]",
      className: "font-mono",
      cell: (r) => (r.cod ? money(r.cod) : <span className="text-muted-foreground">—</span>),
    },
    { key: "state", header: "Result", width: "w-[120px]", cell: (r) => <RowBadge state={r.state} /> },
    {
      key: "detail",
      header: "AWB / problem",
      cell: (r) =>
        r.awb ? (
          <MonoCell>{r.awb}</MonoCell>
        ) : r.messages.length ? (
          <ul className="text-[12px] text-status-bad">
            {r.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const failedChunks = chunks.filter((c) => c.status === "failed");

  return (
    <div className="mt-5 space-y-5">
      <Card
        title="Upload a CSV"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv("natex-booking-template.csv", TEMPLATE_HEADER, [TEMPLATE_EXAMPLE])}
          >
            <Download aria-hidden />
            Download template
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-4 py-3 text-[13px] focus-within:ring-2 focus-within:ring-ring hover:bg-accent">
            <FileUp className="size-4" aria-hidden />
            <span>{fileName ?? "Choose a .csv file"}</span>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Booking CSV file"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </label>
          {prepared ? (
            <Button variant="ghost" size="sm" onClick={reset} disabled={phase === "checking" || phase === "booking"}>
              <RotateCcw aria-hidden />
              Start over
            </Button>
          ) : null}
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
          Required columns:{" "}
          {TEMPLATE_COLUMNS.filter((c) => c.required)
            .map((c) => c.header)
            .join(", ")}
          . Use one allocated, unused preprinted AWB sticker per row. The new template separates address line 1/2, district and province; older files with a single delivery_address column are still accepted. Example AWBs are placeholders and must be replaced. Weight in kg (up to 3 decimals), money in rupees (up to 2 decimals) — nothing is
          rounded; an amount with a third decimal is refused. Nothing is booked until you press
          Book.
        </p>
        {prepared?.unknownColumns.length ? (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Ignored columns: {prepared.unknownColumns.join(", ")}
          </p>
        ) : null}
      </Card>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {prepared?.fileErrors.map((e) => (
        <ErrorNote key={e}>{e}</ErrorNote>
      ))}

      {prepared && prepared.rows.length ? (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricTile label="Rows in file" value={tally.total} />
            <MetricTile
              label={phase === "done" ? "Booked" : "Ready to book"}
              value={phase === "done" || phase === "booking" ? tally.booked : tally.ok}
              hint={phase === "idle" ? "Passed the in-browser checks" : undefined}
            />
            <MetricTile
              label="Need fixing"
              value={tally.bad + tally.failed}
              onClick={() => {
                setOnlyProblems((v) => !v);
                setPage(1);
              }}
              active={onlyProblems}
              hint={onlyProblems ? "Showing problems only" : "Click to filter"}
            />
            <MetricTile label="COD on good rows" value={money(tally.codCents)} />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {phase === "idle" || phase === "checking" ? (
              <Button onClick={() => void check()} pending={phase === "checking"} disabled={sendable.length === 0}>
                Check {sendable.length} row{sendable.length === 1 ? "" : "s"} with NatEx
              </Button>
            ) : null}
            {phase === "checked" ? (
              <Button onClick={book} disabled={tally.ok === 0}>
                Book {tally.ok} parcel{tally.ok === 1 ? "" : "s"}
              </Button>
            ) : null}
            {phase === "booking" ? (
              <Button pending disabled>
                Booking {chunks.filter((c) => c.status !== "pending").length} / {chunks.length} chunks…
              </Button>
            ) : null}
            {phase === "done" && failedChunks.length ? (
              <Button onClick={() => void runChunks(chunks)}>Retry {failedChunks.length} failed chunk{failedChunks.length === 1 ? "" : "s"}</Button>
            ) : null}
            {tally.bad + tally.failed > 0 ? (
              <Button variant="outline" onClick={downloadErrors}>
                <Download aria-hidden />
                Download error report
              </Button>
            ) : null}
            {phase === "done" ? (
              <Button variant="outline" onClick={downloadResults}>
                <Download aria-hidden />
                Download AWBs
              </Button>
            ) : null}
          </div>

          {phase === "done" && tally.booked > 0 ? (
            <output className="flex items-center gap-2 text-[13px] text-status-good">
              <CheckCircle2 className="size-4" aria-hidden />
              {tally.booked} parcel{tally.booked === 1 ? "" : "s"} booked.{" "}
              <Link href="/merchant/pickups" className="underline">
                Request a pickup
              </Link>
            </output>
          ) : null}
          {failedChunks.map((c) => (
            <ErrorNote key={c.key}>
              Lines {c.lines[0]}–{c.lines[c.lines.length - 1]}: {c.error} Retrying sends the same request key, so
              nothing is booked twice.
            </ErrorNote>
          ))}

          <DataTable
            columns={columns}
            rows={pageRows}
            rowKey={(r) => String(r.line)}
            emptyTitle="No rows need fixing"
            pagination={{ page, pageSize: PAGE, total: shown.length, onPageChange: setPage }}
          />
        </>
      ) : null}
    </div>
  );
}

function RowBadge({ state }: { state: RowState }) {
  switch (state) {
    case "booked":
      return <Badge variant="good">Booked</Badge>;
    case "ok":
      return <Badge variant="brand">Ready</Badge>;
    case "unchecked":
      return <Badge variant="muted">Not checked</Badge>;
    case "failed":
      return <Badge variant="warn">Not sent</Badge>;
    default:
      return <Badge variant="bad">Fix</Badge>;
  }
}
