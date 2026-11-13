import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { client, apiMessage } from "@/lib/api";
import { colomboToday, dateTime, humanise } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Page } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { StatusPill } from "@/components/natex/status-pill";
import { ExportCsvButton } from "@/components/natex/export-csv";

type AgingInput = NonNullable<Parameters<typeof client.parcels.statusAging>[0]>;
type AgingResponse = Awaited<ReturnType<typeof client.parcels.statusAging>>;
type AgingRow = AgingResponse["rows"][number];

const PAGE_SIZE = 25;

function ageLabel(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remainder}m`;
  return `${remainder}m`;
}

export default function OpsParcelAging() {
  const [page, setPage] = React.useState(1);
  const [statusChoice, setStatusChoice] = React.useState("open");
  const [branchId, setBranchId] = React.useState("");
  const [enteredFrom, setEnteredFrom] = React.useState("");
  const [enteredTo, setEnteredTo] = React.useState("");
  const [minimumAge, setMinimumAge] = React.useState("");
  const [searchDraft, setSearchDraft] = React.useState("");
  const search = useDebounced(searchDraft.trim(), 250);

  React.useEffect(() => {
    setPage(1);
  }, [statusChoice, branchId, enteredFrom, enteredTo, minimumAge, search]);

  const selectedStatus = statusChoice === "open" || statusChoice === "all"
    ? undefined
    : statusChoice as AgingInput["status"];
  const request = {
    page,
    pageSize: PAGE_SIZE,
    status: selectedStatus,
    includeTerminal: statusChoice === "all",
    branchId: branchId || undefined,
    enteredFrom: enteredFrom || undefined,
    enteredTo: enteredTo || undefined,
    minimumAgeHours: minimumAge === "" ? undefined : Number(minimumAge),
    search: search || undefined,
  } satisfies AgingInput;

  const report = useQuery({
    queryKey: ["parcels", "statusAging", request],
    queryFn: () => client.parcels.statusAging(request),
  });
  const stateMachine = useQuery({
    queryKey: ["parcels", "stateMachine"],
    queryFn: () => client.parcels.stateMachine(),
    staleTime: 10 * 60_000,
  });

  const columns: Column<AgingRow>[] = [
    {
      key: "awb",
      header: "Tracking number",
      width: "w-[175px]",
      cell: (row) => <MonoCell>{row.awb}</MonoCell>,
    },
    {
      key: "status",
      header: "Current status",
      width: "w-[155px]",
      cell: (row) => <StatusPill status={row.status} />,
    },
    {
      key: "branch",
      header: "Accountable branch / hub",
      width: "w-[210px]",
      cell: (row) => row.branchName,
    },
    {
      key: "statusSince",
      header: "Status entered (Colombo)",
      width: "w-[175px]",
      cell: (row) => dateTime(row.statusSince),
    },
    {
      key: "age",
      header: "Time in status",
      width: "w-[115px]",
      align: "right",
      className: "font-mono tabular-nums",
      cell: (row) => ageLabel(row.ageMinutes),
    },
    {
      key: "lastScan",
      header: "Last accepted scan",
      width: "w-[220px]",
      cell: (row) => (
        <div>
          <span>{row.lastScanAt ? dateTime(row.lastScanAt) : "—"}</span>
          {row.lastScanLocation ? (
            <span className="mt-0.5 block text-[11px] text-muted-foreground">
              {row.lastScanLocation}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: "tripEta",
      header: "Transit ETA (Colombo)",
      width: "w-[180px]",
      cell: (row) => row.tripEta ? dateTime(row.tripEta) : "—",
    },
  ];

  return (
    <Page
      title="Parcel Status & Aging"
      description="Open parcels are sorted oldest by their current status. The date range applies to when that status began; no SLA threshold is assumed."
      actions={
        <ExportCsvButton<AgingRow>
          filename={`natex-parcel-status-aging-${colomboToday()}.csv`}
          header={[
            "tracking_number",
            "status",
            "accountable_branch_or_hub",
            "status_entered_colombo",
            "age_hours",
            "last_accepted_scan_colombo",
            "last_scan_location",
            "transit_eta_colombo",
          ]}
          toRow={(row) => [
            row.awb,
            row.status,
            row.branchName,
            dateTime(row.statusSince),
            Number((row.ageMinutes / 60).toFixed(2)),
            row.lastScanAt ? dateTime(row.lastScanAt) : "",
            row.lastScanLocation ?? "",
            row.tripEta ? dateTime(row.tripEta) : "",
          ]}
          fetchPage={(requestedPage) =>
            client.parcels.statusAging({ ...request, page: requestedPage, pageSize: 100 })
          }
        />
      }
    >
      <DataTable
        columns={columns}
        rows={report.data?.rows ?? []}
        rowKey={(row) => row.id}
        loading={report.isPending}
        error={report.isError ? apiMessage(report.error, "The parcel aging report could not be loaded.") : null}
        emptyTitle="No parcels match these filters"
        emptyDescription="Try a wider date range or clear a filter. Results remain limited to the branch scope assigned to your role."
        pagination={{
          page: report.data?.page ?? page,
          pageSize: report.data?.pageSize ?? PAGE_SIZE,
          total: report.data?.total ?? 0,
          onPageChange: setPage,
        }}
        filters={
          <>
            <label className="grid min-w-[150px] gap-1 text-[11px] font-medium text-muted-foreground">
              Status
              <Select value={statusChoice} onChange={(event) => setStatusChoice(event.target.value)}>
                <option value="open">All open statuses</option>
                <option value="all">All statuses</option>
                {(stateMachine.data?.statuses ?? []).map((status) => (
                  <option key={status} value={status}>{humanise(status)}</option>
                ))}
              </Select>
            </label>
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
            <label htmlFor="aging-entered-from" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Status entered from
              <Input id="aging-entered-from" type="date" value={enteredFrom} onChange={(event) => setEnteredFrom(event.target.value)} />
            </label>
            <label htmlFor="aging-entered-to" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Status entered through
              <Input id="aging-entered-to" type="date" value={enteredTo} onChange={(event) => setEnteredTo(event.target.value)} />
            </label>
            <label htmlFor="aging-minimum-hours" className="grid min-w-[145px] gap-1 text-[11px] font-medium text-muted-foreground">
              Minimum age (hours)
              <Input
                id="aging-minimum-hours"
                type="number"
                min={0}
                max={8760}
                step={1}
                inputMode="numeric"
                placeholder="No minimum"
                value={minimumAge}
                onChange={(event) => setMinimumAge(event.target.value)}
              />
            </label>
            <label htmlFor="aging-awb-search" className="grid min-w-[180px] gap-1 text-[11px] font-medium text-muted-foreground">
              Tracking number
              <Input
                id="aging-awb-search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value.toUpperCase())}
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
