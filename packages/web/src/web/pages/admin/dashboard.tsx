import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowRight, CheckCircle2 } from "lucide-react";
import { apiMessage } from "@/lib/api";
import { humanise, money, time } from "@/lib/format";
import { GROUP_COLOUR } from "@/lib/status";
import { SERIES } from "@/lib/chart";
import { ROLE_LABEL } from "@/lib/permissions";
import type { Role } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import {
  CategoryBars,
  DailyArea,
  DailyBars,
  RangeToggle,
  SplitBar,
  StatusDonut,
} from "@/components/natex/charts";
import { useCompanyDashboard, type CompanyDashboard } from "@/queries/dashboard";

/**
 * Company dashboard (Round 6) — the admin's whole-company view and the admin
 * portal's home. One read, `dashboard.company` (adminProc), which composes each
 * module's own aggregate: parcels (volume, outcomes, branches, merchants), cod
 * (cash position and daily flow), delivery and transport (today in the field),
 * NDR, alerts and disputes, identity (people) and merchants.
 *
 * Nothing here is computed from a page of rows in the browser.
 */
export default function AdminDashboard() {
  const [days, setDays] = React.useState(30);
  const query = useCompanyDashboard(days);
  const d = query.data;

  return (
    <Page
      title="Company dashboard"
      description="The whole network at a glance — volume, delivery outcomes, branches, merchants, cash and people."
      actions={
        <div className="flex items-center gap-3">
          {d ? <span className="text-[12px] text-muted-foreground">As of {time(d.generatedAt)}</span> : null}
          <RangeToggle value={days} onChange={setDays} />
        </div>
      }
    >
      {query.error ? (
        <ErrorNote>{apiMessage(query.error, "The company dashboard could not be loaded.")}</ErrorNote>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricTile label="Booked today" value={d?.summary.bookedToday ?? "—"} hint="Asia/Colombo day" />
        <MetricTile label="Open shipments" value={d?.summary.open ?? "—"} hint="Not yet delivered or returned" />
        <MetricTile
          label={`Delivered · ${days}d`}
          value={d?.trends.totals.delivered ?? "—"}
          accent={GROUP_COLOUR.good}
        />
        <MetricTile
          label={`Success · ${days}d`}
          value={d ? (d.trends.successPct === null ? "—" : `${d.trends.successPct}%`) : "—"}
          hint="Delivered ÷ (delivered + failed)"
        />
        <MetricTile label="COD to collect" value={d ? money(d.summary.codOpenCents) : "—"} hint="Declared on open parcels" />
        <MetricTile
          label="Cash with riders"
          value={d ? money(d.cash.inRiderHandsCents) : "—"}
          hint="Collected, not deposited"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        <Card
          title="Network throughput"
          description={
            d
              ? `${d.trends.totals.booked} booked · ${d.trends.totals.delivered} delivered · ${d.trends.totals.attempted} failed attempts · ${d.trends.totals.rto} returns started, last ${days} days.`
              : `Last ${days} days.`
          }
        >
          {d ? (
            <DailyArea
              title="Network throughput"
              height={240}
              data={d.trends.days}
              series={[
                { key: "booked", label: "Booked", colour: SERIES.booked },
                { key: "delivered", label: "Delivered", colour: SERIES.delivered },
                { key: "attempted", label: "Failed attempt", colour: SERIES.attempted },
              ]}
            />
          ) : (
            <Skeleton height={268} />
          )}
        </Card>
        <Card title="Status mix" description={d ? `${d.summary.total} parcels, all time.` : undefined}>
          {d ? <StatusDonut byStatus={d.summary.byStatus} size={176} /> : <Skeleton height={176} />}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card
          title="Parcels by branch"
          description="Accountable branch — open versus finished (delivered, returned, cancelled or written off)."
          actions={<QuickLink to="/admin/branches" label="Branches" />}
        >
          {d ? (
            d.branches.length === 0 ? (
              <Empty>No parcels booked yet.</Empty>
            ) : (
              <CategoryBars
                title="Parcels by branch"
                data={d.branches.map((b) => ({ label: b.name, open: b.open, closed: b.closed }))}
                series={[
                  { key: "open", label: "Open", colour: SERIES.open },
                  { key: "closed", label: "Finished", colour: SERIES.closed },
                ]}
                labelWidth={130}
              />
            )
          ) : (
            <Skeleton height={160} />
          )}
        </Card>
        <Card
          title="Busiest merchants"
          description={`By parcels booked in the last ${days} days.`}
          actions={<QuickLink to="/ops/merchants" label="Merchants" />}
        >
          {d ? <TopMerchants rows={d.topMerchants} /> : <Skeleton height={160} />}
        </Card>
      </div>

      <Card
        title="Cash position"
        description="Every COD rupee collected, by where it sits now (§8 four-way reconciliation)."
        actions={
          d ? (
            d.cash.ledgerSumCents === 0 ? (
              <Badge variant="good">
                <CheckCircle2 className="size-3" aria-hidden /> Ledger balanced
              </Badge>
            ) : (
              <Badge variant="bad">
                <AlertTriangle className="size-3" aria-hidden /> Ledger out by {money(d.cash.ledgerSumCents)}
              </Badge>
            )
          ) : null
        }
      >
        {d ? (
          <div className="space-y-6">
            <SplitBar
              segments={[
                { key: "rider", label: "With riders", colour: SERIES.collected, value: d.cash.inRiderHandsCents },
                { key: "safe", label: "In branch safes", colour: SERIES.deposited, value: d.cash.inBranchSafeCents },
                { key: "await", label: "Awaiting settlement", colour: SERIES.banked, value: d.cash.awaitingSettlementCents },
                { key: "settled", label: "Settled to merchants", colour: SERIES.settled, value: d.cash.settledCents },
              ]}
            />
            <DailyBars
              title="COD through the checkpoints"
              money
              height={200}
              data={d.flow}
              series={[
                { key: "collectedCents", label: "Collected", colour: SERIES.collected },
                { key: "depositedCents", label: "Deposited", colour: SERIES.deposited },
                { key: "bankedCents", label: "Banked", colour: SERIES.banked },
                { key: "settledCents", label: "Settled", colour: SERIES.settled },
              ]}
            />
          </div>
        ) : (
          <Skeleton height={300} />
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="In the field today" actions={<QuickLink to="/ops/runsheets" label="Runsheets" />}>
          <ul className="space-y-2.5 text-[13px]">
            <Row label="Runsheets" value={d ? `${d.delivery.dispatched}/${d.delivery.runsheetsToday} dispatched` : "—"} />
            <Row label="Stops planned" value={d?.delivery.stopsPlanned ?? "—"} />
            <Row label="Delivered" value={d?.delivery.delivered ?? "—"} />
            <Row label="Failed" value={d?.delivery.failed ?? "—"} tone={(d?.delivery.failed ?? 0) > 0 ? "warn" : undefined} />
            <Row
              label="COD collected"
              value={d ? `${money(d.delivery.codCollectedCents)} / ${money(d.delivery.codExpectedCents)}` : "—"}
            />
          </ul>
          <div className="mt-4 border-t pt-3">
            <p className="label-xs text-muted-foreground">Linehaul</p>
            <ul className="mt-2 space-y-2.5 text-[13px]">
              <Row label="Trips planned / loading" value={d?.transport.tripsPlanned ?? "—"} />
              <Row label="Trips on the road" value={d?.transport.tripsInFlight ?? "—"} />
              <Row label="Bags in transit" value={d?.transport.bagsInTransit ?? "—"} />
              <Row
                label="Open custody exceptions"
                value={d?.transport.openExceptions ?? "—"}
                tone={(d?.transport.openExceptions ?? 0) > 0 ? "bad" : undefined}
              />
            </ul>
          </div>
        </Card>

        <Card title="Needs attention" actions={<QuickLink to="/ops/ndr" label="NDR queue" />}>
          <ul className="space-y-2.5 text-[13px]">
            <Row
              label="NDR awaiting merchant"
              value={d?.ndr.open ?? "—"}
              hint={d ? `${d.ndr.overdue} past SLA` : undefined}
              tone={(d?.ndr.overdue ?? 0) > 0 ? "bad" : undefined}
            />
            <Row label="Re-attempts scheduled" value={d?.ndr.reattemptScheduled ?? "—"} />
            <Row
              label="Open money alerts"
              value={d?.alerts.open ?? "—"}
              hint={d ? `${d.alerts.highOpen} high` : undefined}
              tone={(d?.alerts.highOpen ?? 0) > 0 ? "bad" : undefined}
            />
            <Row label="Open cash variance" value={d ? money(d.cash.openVarianceCents) : "—"} tone={d && d.cash.openVarianceCents !== 0 ? "bad" : undefined} />
            <Row
              label="Disputes open / investigating"
              value={d ? `${d.disputes.open} / ${d.disputes.investigating}` : "—"}
              hint={d ? `${d.disputes.overdue} past SLA` : undefined}
              tone={(d?.disputes.overdue ?? 0) > 0 ? "bad" : undefined}
            />
          </ul>
          <div className="mt-4 flex flex-wrap gap-3 border-t pt-3">
            <QuickLink to="/finance/alerts" label="Alerts" />
            <QuickLink to="/finance/disputes" label="Disputes" />
            <QuickLink to="/admin/monitor" label="System monitor" />
          </div>
        </Card>

        <Card title="People & accounts" actions={<QuickLink to="/admin/users" label="Users" />}>
          {d ? <People data={d} /> : <Skeleton height={200} />}
        </Card>
      </div>
    </Page>
  );
}

function TopMerchants({ rows }: { rows: CompanyDashboard["topMerchants"] }) {
  if (rows.length === 0) return <Empty>No parcels booked in this window.</Empty>;
  const max = Math.max(...rows.map((r) => r.parcels), 1);
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="label-xs text-left text-muted-foreground">
          <th className="pb-2 font-medium">Merchant</th>
          <th className="w-[40%] pb-2 font-medium">
            <span className="sr-only">Share</span>
          </th>
          <th className="pb-2 text-right font-medium">Parcels</th>
          <th className="pb-2 text-right font-medium">COD declared</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.merchantId}>
            <td className="truncate py-2 pr-3 font-medium">{r.name}</td>
            <td className="py-2 pr-3">
              <span className="sr-only">{Math.round((r.parcels / max) * 100)}% of the busiest merchant</span>
              <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(r.parcels / max) * 100}%`, backgroundColor: SERIES.open }}
                />
              </div>
            </td>
            <td className="py-2 text-right font-mono">{r.parcels}</td>
            <td className="whitespace-nowrap py-2 pl-3 text-right font-mono">{money(r.codCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function People({ data }: { data: CompanyDashboard }) {
  const merchantsActive = data.merchants.find((m) => m.status === "active")?.count ?? 0;
  const merchantsOther = data.merchants.filter((m) => m.status !== "active");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="label-xs text-muted-foreground">Staff & merchant users</p>
          <p className="mt-1 font-mono text-[20px] font-medium">{data.people.total}</p>
          <p className="text-[11px] text-muted-foreground">{data.people.signedIn} with a live session</p>
        </div>
        <div>
          <p className="label-xs text-muted-foreground">Active merchants</p>
          <p className="mt-1 font-mono text-[20px] font-medium">{merchantsActive}</p>
          <p className="text-[11px] text-muted-foreground">
            {merchantsOther.length === 0
              ? "None suspended"
              : merchantsOther.map((m) => `${m.count} ${humanise(m.status).toLowerCase()}`).join(" · ")}
          </p>
        </div>
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="label-xs text-left text-muted-foreground">
            <th className="pb-1.5 font-medium">Role</th>
            <th className="pb-1.5 text-right font-medium">Active</th>
            <th className="pb-1.5 text-right font-medium">Suspended</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.people.byRole.map((r) => (
            <tr key={r.role}>
              <td className="py-1.5">{ROLE_LABEL[r.role as Role] ?? humanise(r.role)}</td>
              <td className="py-1.5 text-right font-mono">{r.active}</td>
              <td className={`py-1.5 text-right font-mono ${r.suspended > 0 ? "text-status-warn" : "text-muted-foreground"}`}>
                {r.suspended}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "bad" | "warn";
  hint?: string;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">
        {label}
        {hint ? <span className="ml-1.5 text-[11px]">· {hint}</span> : null}
      </span>
      <span
        className={`text-right font-mono font-medium ${tone === "bad" ? "text-status-bad" : tone === "warn" ? "text-status-warn" : ""}`}
      >
        {value}
      </span>
    </li>
  );
}

function QuickLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      href={to}
      className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-brand-ink hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand/40"
    >
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function Skeleton({ height }: { height: number }) {
  return <div className="animate-pulse rounded-md bg-muted" style={{ height }} aria-hidden />;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-muted-foreground">{children}</p>;
}
