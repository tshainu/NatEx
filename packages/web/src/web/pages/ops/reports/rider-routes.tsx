import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { todayInColombo } from "@/pages/hr/shared";

function RouteMap({ points }: { points: { latitude: number; longitude: number }[] }) {
  if (points.length < 2) return <div className="flex h-64 items-center justify-center rounded-xl bg-muted text-sm text-muted-foreground">No route points accepted for this day.</div>;
  const minLat = Math.min(...points.map((p) => p.latitude)); const maxLat = Math.max(...points.map((p) => p.latitude));
  const minLon = Math.min(...points.map((p) => p.longitude)); const maxLon = Math.max(...points.map((p) => p.longitude));
  const padLat = Math.max((maxLat - minLat) * 0.15, 0.001); const padLon = Math.max((maxLon - minLon) * 0.15, 0.001);
  const project = (p: { latitude: number; longitude: number }) => `${20 + ((p.longitude - (minLon - padLon)) / ((maxLon + padLon) - (minLon - padLon))) * 760},${20 + (1 - (p.latitude - (minLat - padLat)) / ((maxLat + padLat) - (minLat - padLat))) * 300}`;
  const line = points.map(project).join(" ");
  const centre = points[Math.floor(points.length / 2)];
  const tile = `https://tile.openstreetmap.org/12/${Math.floor((centre.longitude + 180) / 360 * 4096)}/${Math.floor((1 - Math.asinh(Math.tan(centre.latitude * Math.PI / 180)) / Math.PI) / 2 * 4096)}.png`;
  return <div className="relative h-80 overflow-hidden rounded-xl border bg-[#e8f1e7]"><img src={tile} alt="OpenStreetMap route area" className="absolute inset-0 h-full w-full object-cover opacity-35" /><svg viewBox="0 0 800 340" className="relative h-full w-full"><polyline points={line} fill="none" stroke="#047857" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /><circle cx={Number(line.split(" ")[0]?.split(",")[0])} cy={Number(line.split(" ")[0]?.split(",")[1])} r="10" fill="#fff" stroke="#047857" strokeWidth="5" /><circle cx={Number(line.split(" ").at(-1)?.split(",")[0])} cy={Number(line.split(" ").at(-1)?.split(",")[1])} r="10" fill="#f59e0b" stroke="#fff" strokeWidth="4" /></svg><div className="absolute bottom-2 right-2 rounded bg-white/90 px-2 py-1 text-[10px] text-muted-foreground">© OpenStreetMap contributors</div></div>;
}

export default function RiderRoutesReport() {
  const today = todayInColombo(); const [from, setFrom] = React.useState(today); const [to, setTo] = React.useState(today); const result = useQuery(orpc.riderGps.report.queryOptions({ input: { from, to } }));
  const totalKm = (result.data ?? []).reduce((sum, row) => sum + row.day.distanceMeters, 0) / 1000;
  return <Page title="Rider GPS routes" description="Actual GPS-tracked travel between clock-in and clock-out. Poor-accuracy points and unrealistic jumps are filtered.">
    {result.error ? <ErrorNote>Route data could not be loaded. Check the date range and your role scope.</ErrorNote> : null}
    <Card title="Filters"><div className="grid gap-3 md:grid-cols-3"><Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field><div className="self-end"><Button onClick={() => void result.refetch()}>Refresh</Button></div></div></Card>
    <section className="grid gap-3 sm:grid-cols-3"><Card><p className="text-[12px] text-muted-foreground">Rider-days</p><p className="mt-2 font-mono text-2xl font-semibold">{result.data?.length ?? "—"}</p></Card><Card><p className="text-[12px] text-muted-foreground">Total travel</p><p className="mt-2 font-mono text-2xl font-semibold">{totalKm.toFixed(2)} km</p></Card><Card><p className="text-[12px] text-muted-foreground">Tracking rule</p><p className="mt-2 text-sm font-semibold">Clock-in → clock-out</p></Card></section>
    <Card title="Daily rider routes" description="Combined route distance across all runsheets for each rider-day."><div className="space-y-4">{(result.data ?? []).map((row) => <article key={row.day.id} className="rounded-xl border p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><p className="font-semibold">{row.riderName}</p><p className="font-mono text-xs text-muted-foreground">{row.day.workDate} · {row.branchId} · {row.employeeCode}</p></div><p className="font-mono text-lg font-semibold">{(row.day.distanceMeters / 1000).toFixed(2)} km</p></div><RouteMap points={row.points} /><p className="mt-2 text-xs text-muted-foreground">{row.day.acceptedPoints} accepted points · {row.day.rejectedPoints} filtered · {row.day.syncState}</p></article>)}{!result.isPending && !(result.data ?? []).length ? <p className="py-8 text-center text-sm text-muted-foreground">No GPS route records for this range.</p> : null}</div></Card>
  </Page>;
}
