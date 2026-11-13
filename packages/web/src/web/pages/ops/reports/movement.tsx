import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { client, apiMessage } from "@/lib/api";
import { colomboToday, dateTime, humanise } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";

type MovementReportInput = {
  from: string;
  to: string;
  branchId?: string;
  hubId?: string;
  page: number;
  pageSize: number;
};
type MovementReportRow = {
  id: string;
  timestamp: Date;
  kind: string;
  outcome: string;
  reason: string | null;
  awb: string | null;
  bagCode: string | null;
  tripCode: string | null;
  branchId: string;
  branchName: string;
  hubId: string | null;
  hubName: string | null;
};
type MovementReportResponse = {
  rows: MovementReportRow[];
  total: number;
  page: number;
  pageSize: number;
  branches: { id: string; code: string; name: string; type: string }[];
};
/** The parent registers this route namespace in the shared root API router. */
const reportsClient = client as typeof client & {
  transportReport: {
    movementReport: (input: MovementReportInput) => Promise<MovementReportResponse>;
  };
};

const PAGE_SIZE = 25;
const EXPORT_PAGE_SIZE = 100;

export default function HubBagMovementReport() {
  const today = colomboToday();
  const [page, setPage] = React.useState(1);
  const [from, setFrom] = React.useState(today);
  const [to, setTo] = React.useState(today);
  const [branchId, setBranchId] = React.useState("");
  const [hubId, setHubId] = React.useState("");

  React.useEffect(() => setPage(1), [from, to, branchId, hubId]);

  const request: MovementReportInput = {
    from,
    to,
    branchId: branchId || undefined,
    hubId: hubId || undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  const report = useQuery({
    queryKey: ["transportReport", "movementReport", request],
    queryFn: () => reportsClient.transportReport.movementReport(request),
  });

  const columns: Column<MovementReportRow>[] = [
    {
      key: "timestamp",
      header: "Movement time (Colombo)",
      width: "w-[185px]",
      cell: (row) => dateTime(row.timestamp),
    },
    {
      key: "kind",
      header: "Movement",
      width: "w-[135px]",
      cell: (row) => humanise(row.kind),
    },
    {
      key: "outcome",
      header: "Outcome",
      width: "w-[110px]",
      cell: (row) => humanise(row.outcome),
    },
    {
      key: "awb",
      header: "Tracking number",
      width: "w-[170px]",
      cell: (row) => row.awb ? <MonoCell>{row.awb}</MonoCell> : "—",
    },
    {
      key: "bagTrip",
      header: "Bag / trip",
      width: "w-[170px]",
      cell: (row) => (
        <div>
          <span>{row.bagCode ? <MonoCell>{row.bagCode}</MonoCell> : "—"}</span>
          {row.tripCode ? <span className="mt-0.5 block text-[11px] text-muted-foreground">Trip {row.tripCode}</span> : null}
        </div>
      ),
    },
    {
      key: "branchHub",
      header: "Branch / hub",
      width: "w-[230px]",
      cell: (row) => (
        <div>
          <span>{row.branchName}</span>
          {row.hubName ? <span className="mt-0.5 block text-[11px] text-muted-foreground">Hub · {row.hubName}</span> : null}
        </div>
      ),
    },
    {
      key: "reason",
      header: "Reason / detail",
      width: "w-[260px]",
      cell: (row) => row.reason || "—",
    },
  ];

  return (
    <Page
      title="Hub & Bag Movement"
      description="Read-only scan history for the selected Asia/Colombo dates. Results are limited to your authorized branch/hub scope; precise coordinates and actor details are not shown."
      actions={
        <ExportCsvButton<MovementReportRow>
          filename={`natex-hub-bag-movement-${from}-to-${to}.csv`}
          header={[
            "timestamp_colombo",
            "movement_kind",
            "outcome",
            "tracking_number",
            "bag_code",
            "trip_code",
            "branch",
            "hub",
            "reason",
          ]}
          toRow={(row) => [
            dateTime(row.timestamp),
            row.kind,
            row.outcome,
            row.awb ?? "",
            row.bagCode ?? "",
            row.tripCode ?? "",
            row.branchName,
            row.hubName ?? "",
            row.reason ?? "",
          ]}
          fetchPage={(requestedPage) =>
            reportsClient.transportReport.movementReport({
              ...request,
              page: requestedPage,
              pageSize: EXPORT_PAGE_SIZE,
            })
          }
        />
      }
    >
      <DataTable
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(row) => row.id}
        loading={report.isPending}
        error={report.isError ? apiMessage(report.error, "The movement report could not be loaded.") : null}
        emptyTitle="No movements match these filters"
        emptyDescription="Try a wider date range or clear a branch/hub filter. Results remain server-scoped to your role."
        pagination={{
          page: report.data?.page ?? page,
          pageSize: report.data?.pageSize ?? PAGE_SIZE,
          total: report.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <label htmlFor="movement-report-from" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              From (Colombo)
              <Input id="movement-report-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label htmlFor="movement-report-through" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Through (Colombo)
              <Input id="movement-report-through" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
            <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">
              Branch
              <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="">All authorized branches</option>
                {(report.data?.branches ?? []).filter((branch) => branch.type === "branch").map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>
                ))}
              </Select>
            </label>
            <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">
              Hub
              <Select value={hubId} onChange={(event) => setHubId(event.target.value)}>
                <option value="">All authorized hubs</option>
                {(report.data?.branches ?? []).filter((branch) => branch.type === "hub").map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.code} · {branch.name}</option>
                ))}
              </Select>
            </label>
          </>
        }
      />
    </Page>
  );
}
