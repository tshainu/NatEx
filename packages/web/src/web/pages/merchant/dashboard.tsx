import { Link, useLocation } from "wouter";
import { PackagePlus, Truck, Upload } from "lucide-react";
import { apiMessage } from "@/lib/api";
import { dateTime, humanise, money } from "@/lib/format";
import { BOARD_ORDER, GROUP_COLOUR } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { StatusPill } from "@/components/natex/status-pill";
import { useNdrCounts } from "@/queries/ndr";
import { useMerchantProfile, useParcelSummary, usePickupCounts } from "@/queries/merchant";

/**
 * Merchant dashboard (§10 M3). Every number on this screen is aggregated in SQL
 * under the merchant's own §5 scope by `parcels.summary`,
 * `collection.pickupRequestCounts` and `ndr.counts` — nothing is summed from a
 * page of rows in the browser, so a merchant with 10 000 parcels sees the same
 * truth as one with 10.
 */

export default function MerchantDashboard() {
  const [, navigate] = useLocation();
  const profile = useMerchantProfile();
  const summary = useParcelSummary();
  const pickups = usePickupCounts();
  const ndr = useNdrCounts();

  const merchant = profile.data;
  const s = summary.data;
  const ndrOpen = ndr.data ? ndr.data.open + ndr.data.instructed + ndr.data.reattemptScheduled : undefined;

  const error = profile.error ?? summary.error ?? pickups.error ?? ndr.error;
  const byStatus = new Map((s?.byStatus ?? []).map((r) => [r.status, r.count]));

  return (
    <Page
      title={merchant?.name ?? "Dashboard"}
      description="What is moving for you right now, and what needs your answer."
      actions={
        <div className="flex items-center gap-2">
          {merchant ? (
            <Badge variant={merchant.status === "active" ? "good" : "warn"}>
              {merchant.status === "active" ? "Active" : humanise(merchant.status)}
            </Badge>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <Link href="/merchant/pickups">
              <Truck aria-hidden />
              Request pickup
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/merchant/book">
              <PackagePlus aria-hidden />
              Book parcels
            </Link>
          </Button>
        </div>
      }
    >
      {error ? <ErrorNote>{apiMessage(error, "Your dashboard could not be loaded.")}</ErrorNote> : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricTile label="Booked today" value={s?.bookedToday ?? "—"} hint="Asia/Colombo calendar day" />
        <MetricTile
          label="Open shipments"
          value={s?.open ?? "—"}
          hint="Not yet delivered or returned"
          onClick={() => navigate("/merchant/parcels")}
        />
        <MetricTile
          label="COD to collect"
          value={s ? money(s.codOpenCents) : "—"}
          hint="Declared on open shipments"
        />
        <MetricTile
          label="Need your answer"
          value={ndrOpen ?? "—"}
          hint="Failed deliveries (NDR)"
          accent={ndrOpen ? GROUP_COLOUR.warn : undefined}
          onClick={() => navigate("/merchant/ndr")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MetricTile label="Delivered · 30 days" value={s?.last30d.delivered ?? "—"} />
        <MetricTile
          label="COD on deliveries · 30 days"
          value={s ? money(s.last30d.deliveredCodCents) : "—"}
          hint="Declared amount — settlement is reported by Finance"
        />
        <MetricTile label="Returns started · 30 days" value={s?.last30d.returnsStarted ?? "—"} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
        <Card title="Shipments by status" actions={s ? <span className="font-mono text-[12px] text-muted-foreground">{s.total} all time</span> : null}>
          {s && s.total === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Nothing booked yet. Book a single parcel or upload a CSV under Book parcels.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {BOARD_ORDER.filter((st) => (byStatus.get(st as never) ?? 0) > 0).map((st) => (
                <li key={st}>
                  <Link
                    href={`/merchant/parcels?status=${st}`}
                    className="flex items-center justify-between rounded-md px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <StatusPill status={st} />
                    <span className="font-mono text-[13px]">{byStatus.get(st as never)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {s ? (
            <p className="mt-4 text-[11px] text-muted-foreground">As of {dateTime(s.generatedAt)}</p>
          ) : null}
        </Card>

        <Card title="Pickups">
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Awaiting NatEx</dt>
              <dd className="font-mono">{pickups.data?.requested ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Scheduled with a rider</dt>
              <dd className="font-mono">{pickups.data?.scheduled ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Cancelled</dt>
              <dd className="font-mono">{pickups.data?.cancelled ?? "—"}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/merchant/pickups">Manage pickups</Link>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/merchant/book?mode=csv">
                <Upload aria-hidden />
                Upload CSV
              </Link>
            </Button>
          </div>
        </Card>
      </div>
    </Page>
  );
}
