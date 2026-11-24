import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { Card, ErrorNote, Page } from "@/components/natex/page";

export default function MerchantCommissionsReport() {
  const report = useQuery(orpc.merchants.riderEnrollmentCommissionReport.queryOptions());
  const data = report.data;
  return <Page title="Merchant enrollment commissions" description="Approved rider-enrolled merchants. Commission is credited only after NOS approval at LKR 1,500 per merchant.">
    {report.error ? <ErrorNote>Commission data could not be loaded.</ErrorNote> : null}
    <section className="grid gap-3 sm:grid-cols-3"><Card><p className="text-[12px] text-muted-foreground">Approved merchants</p><p className="mt-2 font-mono text-2xl font-semibold">{data?.totalMerchants ?? "—"}</p></Card><Card><p className="text-[12px] text-muted-foreground">Rate per merchant</p><p className="mt-2 font-mono text-2xl font-semibold">LKR {data?.commissionPerMerchantLkr.toLocaleString() ?? "—"}</p></Card><Card><p className="text-[12px] text-muted-foreground">Total commission</p><p className="mt-2 font-mono text-2xl font-semibold">LKR {data?.totalCommissionLkr.toLocaleString() ?? "—"}</p></Card></section>
    <Card title="Approved enrollment ledger" description="The enrolled-by rider is retained on every onboarding request for audit and payout processing.">
      <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Merchant</th><th className="p-2">Enrolled by</th><th className="p-2">Rider ID</th><th className="p-2">Branch</th><th className="p-2">Approved</th><th className="p-2">Commission</th></tr></thead><tbody>{(data?.rows ?? []).map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2 font-medium">{row.merchantName}</td><td className="p-2">{row.enrolledByName}</td><td className="p-2 font-mono text-[11px]">{row.enrolledById}</td><td className="p-2 font-mono">{row.branchId}</td><td className="p-2">{row.approvedAt ? new Date(row.approvedAt).toLocaleDateString("en-LK") : "—"}</td><td className="p-2 font-mono">LKR 1,500</td></tr>)}</tbody></table>{!report.isPending && (data?.rows.length ?? 0) === 0 ? <p className="py-8 text-center text-[13px] text-muted-foreground">No approved rider enrollments yet.</p> : null}</div>
    </Card>
  </Page>;
}
