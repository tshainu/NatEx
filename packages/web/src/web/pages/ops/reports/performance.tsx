import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { todayInColombo } from "@/pages/hr/shared";
import { useAuth } from "@/components/auth-provider";
import { ExportableTable } from "@/components/natex/exportable-table";

export default function OpsPerformance() {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const hrCanAct = (session?.user.roles ?? [session?.user.role]).some((role) => role === "hr" || role === "admin");
  const today = todayInColombo();
  const [fromDate, setFromDate] = React.useState(today);
  const [toDate, setToDate] = React.useState(today);
  const [branchId, setBranchId] = React.useState("");
  const result = useQuery({ ...orpc.deliveryPerformance.riderDailyPerformance.queryOptions({ input: { fromDate, toDate, branchId: branchId || undefined } }) });
  const payouts = useQuery({ ...orpc.deliveryPerformance.starPayouts.queryOptions({ input: { fromDate, toDate, branchId: branchId || undefined } }) });
  const [selected, setSelected] = React.useState<string[]>([]);
  const generate = useMutation({ ...orpc.deliveryPerformance.generateStarPayout.mutationOptions(), onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.deliveryPerformance.starPayouts.key() }) });
  const financeUpdate = useMutation({ ...orpc.deliveryPerformance.reviewStarPayouts.mutationOptions(), onSuccess: () => { setSelected([]); void queryClient.invalidateQueries({ queryKey: orpc.deliveryPerformance.starPayouts.key() }); } });
  const hrUpdate = useMutation({ ...orpc.deliveryPerformance.approveStarPayouts.mutationOptions(), onSuccess: () => { setSelected([]); void queryClient.invalidateQueries({ queryKey: orpc.deliveryPerformance.starPayouts.key() }); } });
  const update = hrCanAct ? hrUpdate : financeUpdate;
  const rows = result.data ?? [];
  const payable = rows.reduce((sum, row) => sum + row.payableCents, 0);
  return <Page title="Rider performance & star deliveries" description="Successful deliveries use server-side Colombo time. The target is 40, or the assigned count when fewer than 40 parcels were assigned; each delivery above target is LKR 40.">
    {result.error ? <ErrorNote>Performance data could not be loaded. Check the date range and your branch scope.</ErrorNote> : null}
    <Card title="Filters" description="Operations is limited to its hub and child branches. HR, Finance, and Admin can review all branches.">
      <div className="grid gap-3 md:grid-cols-4"><Field label="From"><Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field><Field label="To"><Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></Field><Field label="Branch ID"><Input value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="Optional branch ID" /></Field><div className="self-end"><Button onClick={() => void result.refetch()}>Refresh</Button></div></div>
    </Card>
    <section className="grid gap-3 sm:grid-cols-3"><Card><p className="text-[12px] text-muted-foreground">Rider-days</p><p className="mt-2 font-mono text-2xl font-semibold">{rows.length}</p></Card><Card><p className="text-[12px] text-muted-foreground">Star deliveries</p><p className="mt-2 font-mono text-2xl font-semibold">{rows.reduce((sum, row) => sum + row.starCount, 0)}</p></Card><Card><p className="text-[12px] text-muted-foreground">Calculated payable</p><p className="mt-2 font-mono text-2xl font-semibold">LKR {(payable / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 })}</p></Card></section>
    <Card title="Daily rider results" description="A delivered attempt recorded after 17:00 is not eligible for that day, even if the device captured it earlier.">
      <div className="overflow-x-auto"><ExportableTable filename="natex-performance.csv" className="w-full min-w-[900px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Date</th><th className="p-2">Rider</th><th className="p-2">Branch</th><th className="p-2">Assigned</th><th className="p-2">Delivered by 5pm</th><th className="p-2">Target</th><th className="p-2">Stars</th><th className="p-2">Payable</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.date}-${row.riderId}`} className="border-b border-border/60"><td className="p-2 font-mono">{row.date}</td><td className="p-2">{row.riderName}<span className="block font-mono text-[11px] text-muted-foreground">{row.riderId}</span></td><td className="p-2 font-mono">{row.branchId}</td><td className="p-2">{row.assignedCount}</td><td className="p-2">{row.deliveredByCutoff}</td><td className="p-2">{row.targetCount}</td><td className="p-2 font-semibold">{row.starCount}</td><td className="p-2 font-mono">LKR {(row.payableCents / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 })}</td></tr>)}</tbody></ExportableTable>{!result.isPending && rows.length === 0 ? <p className="py-8 text-center text-[13px] text-muted-foreground">No rider performance records for this range.</p> : null}</div>
    </Card>
    <Card title="Star-delivery payout workflow" description="HR generates the snapshot. Finance can review, approve, reject, or mark selected rows paid; the API also supports bounded bulk actions.">
      <div className="mb-3 flex flex-wrap gap-2"><Button onClick={() => generate.mutate({ fromDate, toDate })} pending={generate.isPending}>Generate payout snapshot</Button><Button variant="outline" disabled={!selected.length || update.isPending} onClick={() => update.mutate({ ids: selected, status: "review" })}>Finance review</Button><Button variant="outline" disabled={!selected.length || update.isPending} onClick={() => update.mutate({ ids: selected, status: "approved" })}>Approve selected</Button><Button variant="outline" disabled={!selected.length || update.isPending} onClick={() => update.mutate({ ids: selected, status: "paid" })}>Mark paid</Button></div>
      <div className="overflow-x-auto"><ExportableTable filename="natex-performance.csv" className="w-full min-w-[900px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Select</th><th className="p-2">Date</th><th className="p-2">Rider</th><th className="p-2">Stars</th><th className="p-2">Payable</th><th className="p-2">Status</th></tr></thead><tbody>{(payouts.data ?? []).map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2"><input type="checkbox" disabled={row.status === "paid"} checked={selected.includes(row.id)} onChange={(e) => setSelected((current) => e.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id))} /></td><td className="p-2 font-mono">{row.performanceDate}</td><td className="p-2">{row.riderName}</td><td className="p-2">{row.starCount}</td><td className="p-2 font-mono">LKR {(row.payableCents / 100).toLocaleString("en-LK", { minimumFractionDigits: 2 })}</td><td className="p-2">{row.status}</td></tr>)}</tbody></ExportableTable></div>
    </Card>
  </Page>;
}
