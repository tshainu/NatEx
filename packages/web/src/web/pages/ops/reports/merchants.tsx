import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { Card, ErrorNote, Page } from "@/components/natex/page";
import { ExportableTable } from "@/components/natex/exportable-table";
export default function MerchantsListReport() {
  const [search, setSearch] = useState("");
  const report = useQuery(orpc.merchants.merchantsList.queryOptions({ input: { page: 1, pageSize: 100, search: search || undefined } }));
  const rows = report.data?.rows ?? [];
  return <Page title="Merchants list" description="All active and historical merchants registered in NatEx. This read-only report is available to every authenticated portal.">
    <Card><div className="flex flex-wrap items-center justify-between gap-3"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search merchant, phone, or address" className="h-9 w-full max-w-md rounded-md border border-border bg-background px-3 text-sm"/><span className="text-xs text-muted-foreground">{report.data?.total ?? 0} merchants</span></div></Card>
    {report.error ? <ErrorNote>Merchant list could not be loaded.</ErrorNote> : null}
    <Card title="Available merchants"><div className="overflow-x-auto"><ExportableTable filename="natex-merchants.csv" className="w-full min-w-[800px] text-left text-[13px]"><thead><tr className="border-b text-[11px] uppercase text-muted-foreground"><th className="p-2">Merchant</th><th className="p-2">Contact</th><th className="p-2">Phone</th><th className="p-2">Address</th><th className="p-2">Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border/60"><td className="p-2 font-medium">{row.name}</td><td className="p-2">{row.contactName}</td><td className="p-2">{row.contactPhone}</td><td className="p-2">{row.address}</td><td className="p-2 capitalize">{row.status}</td></tr>)}</tbody></ExportableTable>{!report.isPending && !rows.length ? <p className="py-8 text-center text-sm text-muted-foreground">No merchants found.</p> : null}</div></Card>
  </Page>;
}
