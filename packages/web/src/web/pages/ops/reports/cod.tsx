import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { client, apiMessage } from "@/lib/api";
import { colomboToday, date, dateTime, humanise, money } from "@/lib/format";
import { centsToRupees } from "@/lib/csv";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { ExportCsvButton } from "@/components/natex/export-csv";

type ReportInput = NonNullable<Parameters<typeof client.cod.reconciliationReport>[0]>;
type ReportResponse = Awaited<ReturnType<typeof client.cod.reconciliationReport>>;
type ReportRow = ReportResponse["rows"][number];

const PAGE_SIZE = 25;

function daysBefore(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day! - days, 12));
  return value.toISOString().slice(0, 10);
}

export default function OpsCodReconciliation() {
  const today = colomboToday();
  const [page, setPage] = React.useState(1);
  const [branchId, setBranchId] = React.useState("");
  const [enteredFrom, setEnteredFrom] = React.useState(() => daysBefore(today, 29));
  const [enteredTo, setEnteredTo] = React.useState(today);

  React.useEffect(() => setPage(1), [branchId, enteredFrom, enteredTo]);

  const request = {
    enteredFrom,
    enteredTo,
    branchId: branchId || undefined,
    page,
    pageSize: PAGE_SIZE,
  } satisfies ReportInput;
  const invalidDateOrder = enteredFrom.length === 10 && enteredTo.length === 10 && enteredFrom > enteredTo;

  const report = useQuery({
    queryKey: ["cod", "reconciliationReport", request],
    queryFn: () => client.cod.reconciliationReport(request),
    enabled: enteredFrom.length === 10 && enteredTo.length === 10 && !invalidDateOrder,
  });

  const columns: Column<ReportRow>[] = [
    {
      key: "awb",
      header: "Tracking number",
      width: "w-[175px]",
      cell: (row) => <MonoCell>{row.awb}</MonoCell>,
    },
    {
      key: "branch",
      header: "Accountable branch / hub",
      width: "w-[220px]",
      cell: (row) => row.branchName,
    },
    {
      key: "bookedAt",
      header: "Booked (Colombo)",
      width: "w-[150px]",
      cell: (row) => date(row.bookedAt),
    },
    {
      key: "expected",
      header: "Expected COD",
      width: "w-[145px]",
      align: "right",
      className: "font-mono tabular-nums",
      cell: (row) => money(row.expectedCents),
    },
    {
      key: "collected",
      header: "Collected COD",
      width: "w-[145px]",
      align: "right",
      className: "font-mono tabular-nums",
      cell: (row) => money(row.collectedCents),
    },
    {
      key: "variance",
      header: "Collected − expected",
      width: "w-[165px]",
      align: "right",
      className: "font-mono tabular-nums",
      cell: (row) => money(row.varianceCents),
    },
    {
      key: "collectedAt",
      header: "Collected (Colombo)",
      width: "w-[170px]",
      cell: (row) => row.collectedAt ? dateTime(row.collectedAt) : "—",
    },
    {
      key: "result",
      header: "Reconciliation",
      width: "w-[135px]",
      cell: (row) => (
        <span className={row.reconciliationStatus === "Mismatch" ? "font-semibold text-status-warn" : ""}>
          {row.reconciliationStatus}
        </span>
      ),
    },
    {
      key: "parcelStatus",
      header: "Parcel status",
      width: "w-[140px]",
      cell: (row) => humanise(row.status),
    },
  ];

  return (
    <Page
      title="COD Reconciliation"
      description="Compare each parcel’s expected COD with live collection entries. “Not collected” is a ledger observation, not an overdue or SLA judgment. Reversed collection entries do not count as collected."
      actions={
        <ExportCsvButton<ReportRow>
          filename={`natex-cod-reconciliation-${enteredFrom}-to-${enteredTo}.csv`}
          disabled={!report.data || invalidDateOrder}
          header={[
            "tracking_number",
            "accountable_branch_or_hub",
            "booked_date_colombo",
            "parcel_status",
            "expected_cod_lkr",
            "collected_cod_lkr",
            "collected_minus_expected_lkr",
            "collected_at_colombo",
            "reconciliation_status",
          ]}
          toRow={(row) => [
            row.awb,
            row.branchName,
            date(row.bookedAt),
            row.status,
            centsToRupees(row.expectedCents),
            centsToRupees(row.collectedCents),
            centsToRupees(row.varianceCents),
            row.collectedAt ? dateTime(row.collectedAt) : "",
            row.reconciliationStatus,
          ]}
          fetchPage={(requestedPage) =>
            client.cod.reconciliationReport({ ...request, page: requestedPage, pageSize: 100 })
          }
        />
      }
    >
      <DataTable
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(row) => row.id}
        loading={report.isPending}
        error={report.isError
          ? apiMessage(report.error, "The COD reconciliation report could not be loaded.")
          : invalidDateOrder
            ? "Choose a booking start date on or before the end date."
            : null}
        emptyTitle="No parcels with COD match these filters"
        emptyDescription="Widen the booking date range or choose another authorized branch. The report includes only the branch scope assigned to your role."
        pagination={{
          page: report.data?.page ?? page,
          pageSize: report.data?.pageSize ?? PAGE_SIZE,
          total: report.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <label className="grid min-w-[190px] gap-1 text-[11px] font-medium text-muted-foreground">
              Branch / hub
              <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="">All authorized branches</option>
                {(report.data?.branches ?? []).map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} · {branch.name} ({humanise(branch.type)})
                  </option>
                ))}
              </Select>
            </label>
            <label htmlFor="cod-report-booked-from" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Booked from
              <Input id="cod-report-booked-from" type="date" value={enteredFrom} max={enteredTo || undefined} onChange={(event) => setEnteredFrom(event.target.value)} />
            </label>
            <label htmlFor="cod-report-booked-through" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Booked through
              <Input id="cod-report-booked-through" type="date" value={enteredTo} min={enteredFrom || undefined} max={today} onChange={(event) => setEnteredTo(event.target.value)} />
            </label>
          </>
        }
      />
    </Page>
  );
}
