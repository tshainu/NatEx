import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { todayInColombo } from "@/pages/hr/shared";
import { SERIES } from "@/lib/chart";
import { DailyBars } from "@/components/natex/charts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { ExportableTable } from "@/components/natex/exportable-table";

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function durationSeconds(row: {
  workDate: string;
  clockInAt: Date | string;
  clockOutAt?: Date | string | null;
}) {
  const start = new Date(row.clockInAt).getTime();
  const recordedEnd = row.clockOutAt ? new Date(row.clockOutAt).getTime() : null;
  const end = recordedEnd ?? (row.workDate <= todayInColombo() ? Date.now() : start);
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1000))
    : 0;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

function formatTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-LK", {
    timeZone: "Asia/Colombo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function currentMonth() {
  return todayInColombo().slice(0, 7);
}

type ReportRow = {
  riderId: string;
  riderName: string;
  employeeCode: string;
  branchId: string;
  day: {
    id: string;
    workDate: string;
    clockInAt: Date | string;
    clockOutAt: Date | string | null;
    distanceMeters: number;
    acceptedPoints: number;
    rejectedPoints: number;
    syncState: string;
  };
};

export default function VehicleRunningReport() {
  const [month, setMonth] = React.useState(currentMonth);
  const [branchId, setBranchId] = React.useState("");
  const [riderId, setRiderId] = React.useState("");
  const bounds = React.useMemo(() => monthBounds(month), [month]);
  const report = useQuery(orpc.riderGps.report.queryOptions({ input: bounds }));
  const rows = (report.data ?? []) as ReportRow[];

  const branches = React.useMemo(
    () => [...new Set(rows.map((row) => row.branchId))].sort(),
    [rows],
  );
  const riders = React.useMemo(() => {
    const seen = new Map<string, string>();
    rows.forEach((row) => {
      if (!branchId || row.branchId === branchId) seen.set(row.riderId, row.riderName);
    });
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows, branchId]);

  React.useEffect(() => {
    if (riderId && !riders.some(([id]) => id === riderId)) setRiderId("");
  }, [riderId, riders]);

  const filteredRows = React.useMemo(
    () =>
      rows.filter(
        (row) => (!branchId || row.branchId === branchId) && (!riderId || row.riderId === riderId),
      ),
    [rows, branchId, riderId],
  );

  const summary = React.useMemo(() => {
    const byRider = new Map<
      string,
      {
        riderId: string;
        riderName: string;
        employeeCode: string;
        branchId: string;
        seconds: number;
        days: number;
        km: number;
      }
    >();
    filteredRows.forEach((row) => {
      const current = byRider.get(row.riderId) ?? {
        riderId: row.riderId,
        riderName: row.riderName,
        employeeCode: row.employeeCode,
        branchId: row.branchId,
        seconds: 0,
        days: 0,
        km: 0,
      };
      current.seconds += durationSeconds(row.day);
      current.days += 1;
      current.km += row.day.distanceMeters / 1000;
      byRider.set(row.riderId, current);
    });
    return [...byRider.values()].sort((a, b) => b.seconds - a.seconds);
  }, [filteredRows]);

  const chartData = React.useMemo(() => {
    const byDate = new Map<string, number>();
    filteredRows.forEach((row) =>
      byDate.set(
        row.day.workDate,
        (byDate.get(row.day.workDate) ?? 0) + durationSeconds(row.day) / 3600,
      ),
    );
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, hours]) => ({ date, hours: Number(hours.toFixed(2)) }));
  }, [filteredRows]);

  const selectedRider = riderId ? summary.find((row) => row.riderId === riderId) : null;
  const detailRows = React.useMemo(
    () => [...filteredRows].sort((a, b) => a.day.workDate.localeCompare(b.day.workDate)),
    [filteredRows],
  );
  const totalHours = summary.reduce((total, row) => total + row.seconds, 0) / 3600;

  return (
    <Page
      title="Vehicle running chart"
      description="Daily and monthly GPS running time for riders. Select a rider to inspect every running session in the selected month; Rider GPS routes remains the map view."
    >
      {report.error ? (
        <ErrorNote>
          Vehicle running data could not be loaded. Check the selected month and your role scope.
        </ErrorNote>
      ) : null}
      <Card
        title="Report filters"
        description="The report is limited to the branches and riders your role is authorized to view."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
            Month
            <Input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value || currentMonth())}
            />
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
            Branch
            <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
              <option value="">All authorized branches</option>
              {branches.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-[11px] font-medium text-muted-foreground">
            Rider
            <Select value={riderId} onChange={(event) => setRiderId(event.target.value)}>
              <option value="">All riders</option>
              {riders.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
          <div className="self-end">
            <Button
              variant="outline"
              onClick={() => void report.refetch()}
              pending={report.isFetching}
            >
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      <section className="grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-[12px] text-muted-foreground">Riders tracked</p>
          <p className="mt-2 font-mono text-2xl font-semibold">
            {report.isPending ? "—" : summary.length}
          </p>
        </Card>
        <Card>
          <p className="text-[12px] text-muted-foreground">Running time in month</p>
          <p className="mt-2 font-mono text-2xl font-semibold">
            {report.isPending ? "—" : formatDuration(totalHours * 3600)}
          </p>
        </Card>
        <Card>
          <p className="text-[12px] text-muted-foreground">Selected period</p>
          <p className="mt-2 font-mono text-2xl font-semibold">{month}</p>
        </Card>
      </section>

      <Card
        title="Monthly rider totals"
        description="One row per rider. Click a row to open date-wise running details."
      >
        <div className="overflow-x-auto">
          <ExportableTable filename="natex-vehicle_running.csv" className="w-full min-w-[720px] text-left text-[13px]">
            <thead>
              <tr className="border-b text-[11px] uppercase text-muted-foreground">
                <th className="p-2">Rider</th>
                <th className="p-2">Branch</th>
                <th className="p-2">Days</th>
                <th className="p-2">Monthly running</th>
                <th className="p-2">Distance</th>
                <th className="p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr
                  key={row.riderId}
                  className={`border-b border-border/60 ${riderId === row.riderId ? "bg-muted/50" : ""}`}
                >
                  <td className="p-2">
                    <button
                      type="button"
                      className="text-left font-semibold text-primary underline-offset-2 hover:underline"
                      onClick={() => setRiderId(row.riderId)}
                    >
                      {row.riderName}
                      <span className="block font-mono text-[11px] text-muted-foreground">
                        {row.employeeCode}
                      </span>
                    </button>
                  </td>
                  <td className="p-2 font-mono">{row.branchId}</td>
                  <td className="p-2">{row.days}</td>
                  <td className="p-2 font-mono font-semibold">{formatDuration(row.seconds)}</td>
                  <td className="p-2 font-mono">{row.km.toFixed(2)} km</td>
                  <td className="p-2">
                    <Button variant="outline" onClick={() => setRiderId(row.riderId)}>
                      View dates
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </ExportableTable>
          {!report.isPending && summary.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No vehicle running records for this month and filter.
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title={selectedRider ? `Daily running — ${selectedRider.riderName}` : "Daily running chart"}
        description={
          selectedRider
            ? `Date-wise running time for ${month}.`
            : "Combined running hours by day for the current filters. Select a rider for an individual drill-down."
        }
      >
        <DailyBars
          data={chartData}
          series={[{ key: "hours", label: "Running hours", colour: SERIES.open }]}
          title="Daily vehicle running hours"
        />
      </Card>

      {selectedRider ? (
        <Card
          title="Date-wise rider details"
          description="Clock times use Asia/Colombo. An open current session is shown as Active and runs through the current time."
        >
          <div className="overflow-x-auto">
            <ExportableTable filename="natex-vehicle_running.csv" className="w-full min-w-[980px] text-left text-[13px]">
              <thead>
                <tr className="border-b text-[11px] uppercase text-muted-foreground">
                  <th className="p-2">Date</th>
                  <th className="p-2">Clock in</th>
                  <th className="p-2">Clock out</th>
                  <th className="p-2">Running time</th>
                  <th className="p-2">Distance</th>
                  <th className="p-2">GPS points</th>
                  <th className="p-2">Sync</th>
                </tr>
              </thead>
              <tbody>
                {detailRows.map((row) => {
                  const active = !row.day.clockOutAt;
                  return (
                    <tr key={row.day.id} className="border-b border-border/60">
                      <td className="p-2 font-mono">{row.day.workDate}</td>
                      <td className="p-2">{formatTime(row.day.clockInAt)}</td>
                      <td className="p-2">
                        {active ? (
                          <span className="font-semibold text-status-good">Active</span>
                        ) : (
                          formatTime(row.day.clockOutAt)
                        )}
                      </td>
                      <td className="p-2 font-mono font-semibold">
                        {formatDuration(durationSeconds(row.day))}
                      </td>
                      <td className="p-2 font-mono">
                        {(row.day.distanceMeters / 1000).toFixed(2)} km
                      </td>
                      <td className="p-2">
                        {row.day.acceptedPoints} accepted{" "}
                        <span className="text-muted-foreground">
                          · {row.day.rejectedPoints} filtered
                        </span>
                      </td>
                      <td className="p-2 capitalize">{row.day.syncState}</td>
                    </tr>
                  );
                })}
              </tbody>
            </ExportableTable>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
