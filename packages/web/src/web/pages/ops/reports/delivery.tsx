import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { client, apiMessage } from "@/lib/api";
import { colomboToday, dateTime } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";

type ReportInput = {
  fromDate?: string;
  toDate?: string;
  branchId?: string;
  outcome?: "delivered" | "failed";
  search?: string;
  page: number;
  pageSize: number;
};
type ReportResponse = {
  rows: {
    awb: string;
    attemptNo: number;
    outcome: "delivered" | "failed";
    failureReason: string | null;
    timestamp: Date;
    branchLabel: string | null;
    riderName: string | null;
    riderId: string | null;
    runsheetCode: string | null;
  }[];
  total: number;
  page: number;
  pageSize: number;
  branches: { id: string; code: string; name: string; type: string }[];
};
// The parent task registers this isolated namespace in the shared root router.
const reportClient = client as typeof client & {
  deliveryReport: { attemptsReport: (input: ReportInput) => Promise<ReportResponse> };
};
type ReportRow = ReportResponse["rows"][number];
const PAGE_SIZE = 25;

export default function OpsDeliveryAttemptsReport() {
  const [page, setPage] = React.useState(1);
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");
  const [branchId, setBranchId] = React.useState("");
  const [outcomeChoice, setOutcomeChoice] = React.useState("all");
  const [search, setSearch] = React.useState("");

  React.useEffect(() => setPage(1), [fromDate, toDate, branchId, outcomeChoice, search]);

  const outcome = outcomeChoice === "all" ? undefined : (outcomeChoice as ReportInput["outcome"]);
  const filters = {
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    branchId: branchId || undefined,
    outcome,
    search: search.trim() || undefined,
  };
  const request: ReportInput = { ...filters, page, pageSize: PAGE_SIZE };
  const report = useQuery({
    queryKey: ["deliveryReport", "attemptsReport", request],
    queryFn: () => reportClient.deliveryReport.attemptsReport(request),
  });

  const columns: Column<ReportRow>[] = [
    {
      key: "awb",
      header: "AWB",
      width: "w-[155px]",
      cell: (row) => <MonoCell>{row.awb}</MonoCell>,
    },
    { key: "attempt", header: "Attempt", width: "w-[90px]", cell: (row) => row.attemptNo },
    {
      key: "outcome",
      header: "Outcome",
      width: "w-[110px]",
      cell: (row) => (row.outcome === "delivered" ? "Delivered" : "Failed"),
    },
    {
      key: "reason",
      header: "Failure reason",
      width: "w-[190px]",
      cell: (row) => row.failureReason ?? "—",
    },
    {
      key: "timestamp",
      header: "Timestamp (Colombo)",
      width: "w-[175px]",
      cell: (row) => dateTime(row.timestamp),
    },
    {
      key: "branch",
      header: "Branch",
      width: "w-[200px]",
      cell: (row) => row.branchLabel ?? "Unassigned",
    },
    {
      key: "rider",
      header: "Rider",
      width: "w-[180px]",
      cell: (row) =>
        row.riderName ? (
          <span>
            {row.riderName}
            {row.riderId ? (
              <span className="ml-1 text-muted-foreground">({row.riderId})</span>
            ) : null}
          </span>
        ) : (
          (row.riderId ?? "—")
        ),
    },
    {
      key: "runsheet",
      header: "Runsheet",
      width: "w-[145px]",
      cell: (row) => (row.runsheetCode ? <MonoCell>{row.runsheetCode}</MonoCell> : "—"),
    },
  ];

  return (
    <Page
      title="Delivery & Failed Attempts"
      description="Read-only delivery outcomes with server-side paging. Ops sees only the assigned branch or hub and its child branches; dates use Asia/Colombo calendar boundaries."
      actions={
        <ExportCsvButton<ReportRow>
          filename={`natex-delivery-attempts-${colomboToday()}.csv`}
          header={[
            "awb",
            "attempt_no",
            "outcome",
            "failure_reason",
            "timestamp_colombo",
            "authorized_branch",
            "rider_name",
            "rider_id",
            "runsheet_code",
          ]}
          toRow={(row) => [
            row.awb,
            row.attemptNo,
            row.outcome,
            row.failureReason ?? "",
            dateTime(row.timestamp),
            row.branchLabel ?? "Unassigned",
            row.riderName ?? "",
            row.riderId ?? "",
            row.runsheetCode ?? "",
          ]}
          fetchPage={(requestedPage) =>
            reportClient.deliveryReport.attemptsReport({
              ...filters,
              page: requestedPage,
              pageSize: 100,
            })
          }
        />
      }
    >
      <DataTable
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(row) =>
          `${row.awb}-${row.attemptNo}-${row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp}`
        }
        loading={report.isPending}
        error={
          report.isError
            ? apiMessage(report.error, "The delivery-attempt report could not be loaded.")
            : null
        }
        emptyTitle="No delivery attempts match these filters"
        emptyDescription="Try a wider date range or clear a filter. Results remain within the branch scope assigned to your role."
        pagination={{
          page: report.data?.page ?? page,
          pageSize: report.data?.pageSize ?? PAGE_SIZE,
          total: report.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <label htmlFor="delivery-report-from" className="grid min-w-[140px] gap-1 text-[11px] font-medium text-muted-foreground">
              From (Colombo)
              <Input
                id="delivery-report-from"
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </label>
            <label htmlFor="delivery-report-through" className="grid min-w-[140px] gap-1 text-[11px] font-medium text-muted-foreground">
              Through (Colombo)
              <Input
                id="delivery-report-through"
                type="date"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
              />
            </label>
            <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">
              Branch / hub
              <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="">All authorized branches</option>
                {(report.data?.branches ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} · {branch.name}
                  </option>
                ))}
              </Select>
            </label>
            <label htmlFor="delivery-report-outcome" className="grid min-w-[135px] gap-1 text-[11px] font-medium text-muted-foreground">
              Outcome
              <Select
                id="delivery-report-outcome"
                value={outcomeChoice}
                onChange={(event) => setOutcomeChoice(event.target.value)}
              >
                <option value="all">Delivered and failed</option>
                <option value="delivered">Delivered</option>
                <option value="failed">Failed</option>
              </Select>
            </label>
            <label htmlFor="delivery-report-awb" className="grid min-w-[165px] gap-1 text-[11px] font-medium text-muted-foreground">
              AWB
              <Input
                id="delivery-report-awb"
                value={search}
                onChange={(event) => setSearch(event.target.value.toUpperCase())}
                placeholder="Search AWB"
                autoComplete="off"
              />
            </label>
          </>
        }
      />
    </Page>
  );
}
