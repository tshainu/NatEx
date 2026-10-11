import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Printer, RefreshCw, Search, Undo2 } from "lucide-react";
import { client, orpc, apiMessage } from "@/lib/api";
import { money, dateTime, humanise } from "@/lib/format";
import { rupeesToCents } from "@/lib/csv";
import { useDebounced } from "@/lib/hooks";
import { Page, Card, ErrorNote, KeyValueGrid, KeyValue } from "@/components/natex/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type Row = Awaited<ReturnType<typeof client.freight.entries>>["rows"][number];
type ChargeRow = Awaited<ReturnType<typeof client.freight.charges>>["rows"][number];
type Mode = "reconcile" | "refund" | null;

export default function FinanceFreight() {
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const [entryType, setEntryType] = React.useState<"all" | "collection" | "refund" | "adjustment">("all");
  const [page, setPage] = React.useState(1);
  const [chargePage, setChargePage] = React.useState(1);
  const [payerFilter, setPayerFilter] = React.useState<"all" | "sender" | "recipient">("all");
  const [selected, setSelected] = React.useState<Row | null>(null);
  const [selectedCharge, setSelectedCharge] = React.useState<ChargeRow | null>(null);
  const [mode, setMode] = React.useState<Mode>(null);
  const [reference, setReference] = React.useState("");
  const [note, setNote] = React.useState("");
  const [refundRupees, setRefundRupees] = React.useState("");
  const [refundMethod, setRefundMethod] = React.useState<"cash" | "bank_transfer" | "qr" | "card">("cash");
  const [refundReference, setRefundReference] = React.useState("");
  const [refundReason, setRefundReason] = React.useState("");
  const [actionError, setActionError] = React.useState<string | null>(null);
  const debounced = useDebounced(search.trim(), 250);
  const cents = rupeesToCents(refundRupees);
  const refundAmount = "cents" in cents ? cents.cents : 0;

  React.useEffect(() => setPage(1), [debounced, entryType]);
  React.useEffect(() => setChargePage(1), [debounced, payerFilter]);

  const list = useQuery({
    ...orpc.freight.entries.queryOptions({ input: {
      awbOrReceipt: debounced || undefined,
      entryType: entryType === "all" ? undefined : entryType,
      page,
      pageSize: 50,
    } }),
    placeholderData: (previous) => previous,
    refetchInterval: 20_000,
  });
  const chargeList = useQuery({
    ...orpc.freight.charges.queryOptions({ input: {
      awbOrCode: debounced || undefined,
      payer: payerFilter === "all" ? undefined : payerFilter,
      page: chargePage,
      pageSize: 50,
    } }),
    placeholderData: (previous) => previous,
    refetchInterval: 20_000,
  });

  const reconcile = useMutation({
    mutationFn: () => client.freight.reconcile({ entryId: selected!.entry.id, reference: reference.trim(), note: note.trim() || null }),
    onSuccess: () => {
      setMode(null);
      setReference("");
      setNote("");
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: orpc.freight.key() });
    },
    onError: (error) => setActionError(apiMessage(error, "This freight collection could not be reconciled.")),
  });

  const refund = useMutation({
    mutationFn: () => client.freight.refund({
      chargeId: selected!.charge.id,
      amountCents: refundAmount,
      paymentMethod: refundMethod,
      externalReference: refundMethod === "cash" ? null : refundReference.trim(),
      reason: refundReason.trim(),
    }),
    onSuccess: () => {
      setMode(null);
      setRefundRupees("");
      setRefundReference("");
      setRefundReason("");
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: orpc.freight.key() });
    },
    onError: (error) => setActionError(apiMessage(error, "This refund could not be recorded.")),
  });

  const openAction = (row: Row, next: Exclude<Mode, null>) => {
    setSelected(row);
    setSelectedCharge(null);
    setMode(next);
    setActionError(null);
  };
  const printSelected = (row: Row) => {
    setSelected(row);
    setSelectedCharge(null);
    window.setTimeout(() => window.print(), 100);
  };
  const printCharge = (row: ChargeRow) => {
    setSelected(null);
    setSelectedCharge(row);
    window.setTimeout(() => window.print(), 100);
  };

  return (
    <Page title="Customer courier freight" description="Retail sender/recipient freight charges, receipts, reconciliations and refunds. This accounting is independent of COD and Merchant settlement.">
      <Card title="Freight charges &amp; amounts due" description="Includes charges not yet collected, so recipient-paid parcels stay visible until the Rider records payment.">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Search" className="min-w-[240px] flex-1">
            <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-8" placeholder="AWB, charge, customer, phone" aria-label="Search freight charges" /></div>
          </Field>
          <Field label="Payer" className="w-[190px]"><Select value={payerFilter} onChange={(event) => setPayerFilter(event.target.value as typeof payerFilter)}><option value="all">All payers</option><option value="sender">Sender</option><option value="recipient">Recipient</option></Select></Field>
          <Button variant="outline" size="sm" onClick={() => { setSearch(""); setEntryType("all"); setPayerFilter("all"); setPage(1); setChargePage(1); }}><RefreshCw aria-hidden />Reset</Button>
        </div>
        {chargeList.isError ? <ErrorNote>The freight charge register could not be loaded.</ErrorNote> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left text-[12px]">
            <thead><tr className="border-b text-muted-foreground"><th className="p-2">Booked / charge</th><th className="p-2">AWB / customers</th><th className="p-2">Freight payer</th><th className="p-2 text-right">Charge</th><th className="p-2 text-right">Net paid</th><th className="p-2 text-right">Balance</th><th className="p-2">Action</th></tr></thead>
            <tbody>
              {(chargeList.data?.rows ?? []).map((row) => (
                <tr key={row.charge.id} className="border-b align-top hover:bg-muted/30">
                  <td className="p-2"><span className="font-mono">{row.charge.code}</span><br /><span className="text-muted-foreground">{dateTime(row.charge.createdAt)}</span></td>
                  <td className="p-2"><span className="font-mono font-semibold">{row.charge.awb}</span><br />{row.charge.senderName} → {row.charge.recipientName}</td>
                  <td className="p-2">{row.charge.payer === "sender" ? "Sender · counter" : "Recipient · due at delivery"}</td>
                  <td className="p-2 text-right font-mono">{money(row.charge.amountCents)}</td>
                  <td className="p-2 text-right font-mono">{money(row.paidCents)}</td>
                  <td className={`p-2 text-right font-mono font-semibold ${row.dueCents > 0 ? "text-status-warn" : "text-status-good"}`}>{money(row.dueCents)}<br /><Badge variant={row.dueCents > 0 ? "outline" : "brand"}>{row.dueCents > 0 ? "Open" : "Settled"}</Badge></td>
                  <td className="p-2"><Button size="sm" variant="outline" onClick={() => printCharge(row)}><Printer aria-hidden />Charge notice</Button></td>
                </tr>
              ))}
              {!chargeList.isPending && (chargeList.data?.rows.length ?? 0) === 0 ? <tr><td className="p-8 text-center text-muted-foreground" colSpan={7}>No customer-freight charges match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between text-[12px] text-muted-foreground"><span>{chargeList.data ? `${chargeList.data.total} freight charges · page ${chargeList.data.page}` : "Loading charges…"}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={chargePage <= 1} onClick={() => setChargePage((value) => value - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={!chargeList.data || chargePage * chargeList.data.pageSize >= chargeList.data.total} onClick={() => setChargePage((value) => value + 1)}>Next</Button></div></div>
      </Card>

      <Card title="Freight collection register" description="Search by AWB, receipt, sender, recipient or phone number.">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="Entry type" className="w-[180px]"><Select value={entryType} onChange={(event) => setEntryType(event.target.value as typeof entryType)}><option value="all">All entries</option><option value="collection">Collections</option><option value="refund">Refunds</option><option value="adjustment">Adjustments</option></Select></Field>
        </div>
        {list.isError ? <ErrorNote>The courier-freight ledger could not be loaded.</ErrorNote> : null}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] border-collapse text-left text-[12px]">
            <thead><tr className="border-b text-muted-foreground"><th className="p-2">Date / receipt</th><th className="p-2">AWB / customer</th><th className="p-2">Payer / route</th><th className="p-2">Entry</th><th className="p-2 text-right">Amount</th><th className="p-2">Collected by</th><th className="p-2">Reconciliation</th><th className="p-2">Actions</th></tr></thead>
            <tbody>
              {(list.data?.rows ?? []).map((row) => (
                <tr key={row.entry.id} className="border-b align-top hover:bg-muted/30">
                  <td className="p-2"><span className="font-mono">{row.entry.code}</span><br /><span className="text-muted-foreground">{dateTime(row.entry.ts)}</span></td>
                  <td className="p-2"><span className="font-mono font-semibold">{row.charge.awb}</span><br />{row.charge.senderName} → {row.charge.recipientName}</td>
                  <td className="p-2">{humanise(row.entry.payer)}<br /><span className="text-muted-foreground">{row.entry.payer === "sender" ? "Counter" : "At delivery"}</span></td>
                  <td className="p-2"><Badge variant={row.entry.entryType === "collection" ? "brand" : row.entry.entryType === "refund" ? "outline" : "milestone"}>{humanise(row.entry.entryType)}</Badge><br /><span className="text-muted-foreground">{humanise(row.entry.paymentMethod)}</span></td>
                  <td className={`p-2 text-right font-mono font-semibold ${row.entry.amountCents < 0 ? "text-status-bad" : ""}`}>{money(row.entry.amountCents)}</td>
                  <td className="p-2">{row.entry.collectorName}<br /><span className="text-muted-foreground">{row.entry.branchId}</span></td>
                  <td className="p-2">{row.reconciliation ? <Badge variant="brand"><Check aria-hidden /> Reconciled · {row.reconciliation.reference}</Badge> : row.entry.entryType === "collection" ? <Badge variant="outline">Pending review</Badge> : <span className="text-muted-foreground">—</span>}</td>
                  <td className="p-2"><div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => printSelected(row)}><Printer aria-hidden />Receipt</Button>{row.entry.entryType === "collection" && !row.reconciliation ? <Button size="sm" variant="outline" onClick={() => openAction(row, "reconcile")}>Reconcile</Button> : null}{row.entry.entryType === "collection" && row.entry.amountCents > 0 ? <Button size="sm" variant="ghost" onClick={() => openAction(row, "refund")}><Undo2 aria-hidden />Refund</Button> : null}</div></td>
                </tr>
              ))}
              {!list.isPending && (list.data?.rows.length ?? 0) === 0 ? <tr><td className="p-8 text-center text-muted-foreground" colSpan={8}>No customer-freight entries match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between text-[12px] text-muted-foreground"><span>{list.data ? `${list.data.total} ledger entries · page ${list.data.page}` : "Loading ledger…"}</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={!list.data || page * list.data.pageSize >= list.data.total} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>
      </Card>

      {mode && selected ? (
        <Dialog open onOpenChange={(open) => { if (!open) setMode(null); }} title={mode === "reconcile" ? "Reconcile freight collection" : "Record freight refund"}>
          {mode === "reconcile" ? (
            <div className="space-y-4">
              <p className="text-sm">Confirm the bank deposit, cash bag or other clearing reference for receipt <span className="font-mono">{selected.entry.code}</span>.</p>
              <KeyValueGrid columns={2}><KeyValue label="AWB" mono>{selected.charge.awb}</KeyValue><KeyValue label="Amount" mono>{money(selected.entry.amountCents)}</KeyValue></KeyValueGrid>
              <Field label="Clearing / deposit reference"><Input value={reference} onChange={(event) => setReference(event.target.value)} required /></Field>
              <Field label="Note (optional)"><Textarea value={note} onChange={(event) => setNote(event.target.value)} /></Field>
              {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMode(null)}>Cancel</Button><Button disabled={reference.trim().length < 2 || reconcile.isPending} onClick={() => reconcile.mutate()}>{reconcile.isPending ? "Saving…" : "Confirm reconciliation"}</Button></div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">Refunds create a signed reversal entry. They never delete the original customer payment.</p>
              <KeyValueGrid columns={2}><KeyValue label="AWB" mono>{selected.charge.awb}</KeyValue><KeyValue label="Charge" mono>{money(selected.charge.amountCents)}</KeyValue></KeyValueGrid>
              <Field label="Refund amount (Rs.)" error={"error" in cents ? cents.error : null}><Input value={refundRupees} onChange={(event) => setRefundRupees(event.target.value)} inputMode="decimal" /></Field>
              <Field label="Refund method"><Select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as typeof refundMethod)}><option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="qr">QR payment</option><option value="card">Card</option></Select></Field>
              {refundMethod !== "cash" ? <Field label="Transfer / refund reference"><Input value={refundReference} onChange={(event) => setRefundReference(event.target.value)} /></Field> : null}
              <Field label="Reason"><Textarea value={refundReason} onChange={(event) => setRefundReason(event.target.value)} maxLength={500} /></Field>
              {actionError ? <ErrorNote>{actionError}</ErrorNote> : null}
              <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMode(null)}>Cancel</Button><Button variant="destructive" disabled={refundAmount <= 0 || refundReason.trim().length < 8 || (refundMethod !== "cash" && refundReference.trim().length < 3) || refund.isPending} onClick={() => refund.mutate()}>{refund.isPending ? "Saving…" : "Record refund"}</Button></div>
            </div>
          )}
        </Dialog>
      ) : null}

      {selected ? <ReceiptSlip row={selected} /> : null}
      {selectedCharge ? <ChargeSlip row={selectedCharge} /> : null}
    </Page>
  );
}

function ReceiptSlip({ row }: { row: Row }) {
  const { entry, charge } = row;
  const isRefund = entry.entryType === "refund";
  return (
    <>
      <style>{`@media screen {.freight-ledger-slip{display:none}} @media print {body *{visibility:hidden!important}.freight-ledger-slip,.freight-ledger-slip *{visibility:visible!important}.freight-ledger-slip{display:block!important;position:fixed;inset:0;background:white;color:#111;padding:36px;font:14px Arial,sans-serif}.freight-ledger-slip table{width:100%;border-collapse:collapse}.freight-ledger-slip td{padding:7px;border-bottom:1px solid #ddd}.freight-ledger-slip .right{text-align:right;font-family:monospace}}`}</style>
      <section className="freight-ledger-slip max-w-3xl rounded-lg border border-border bg-card p-6" aria-label="Printable courier freight receipt">
        <div className="flex items-start justify-between border-b pb-4"><div><h2 className="text-xl font-bold">NatEx · Customer Freight {isRefund ? "Refund" : "Receipt"}</h2><p className="mt-1 text-sm text-muted-foreground">Retail consignment · independent of COD</p></div><div className="text-right"><p className="font-mono font-semibold">{entry.code}</p><p className="text-xs">{dateTime(entry.ts)}</p></div></div>
        <div className="grid grid-cols-2 gap-4 py-4 text-sm"><div><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p></div><div><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p></div></div>
        <table><tbody><tr><td>AWB</td><td className="right">{charge.awb}</td></tr><tr><td>Courier freight charge</td><td className="right">{money(charge.amountCents)}</td></tr><tr><td>Entry</td><td className="right">{humanise(entry.entryType)}</td></tr><tr><td>Amount {isRefund ? "refunded" : "received"}</td><td className="right">{money(Math.abs(entry.amountCents))}</td></tr><tr><td>Payment method</td><td className="right">{humanise(entry.paymentMethod)}</td></tr><tr><td>Collected / refunded by</td><td className="right">{entry.collectorName}</td></tr>{entry.externalReference ? <tr><td>Payment reference</td><td className="right">{entry.externalReference}</td></tr> : null}</tbody></table>
        <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">Keep this document for your records. Customer courier freight is separate from Cash on Delivery and Merchant settlements. This is a payment receipt, not a VAT tax invoice.</p>
      </section>
    </>
  );
}

function ChargeSlip({ row }: { row: ChargeRow }) {
  const { charge, paidCents, dueCents } = row;
  return (
    <>
      <style>{`@media screen {.freight-charge-slip{display:none}} @media print {body *{visibility:hidden!important}.freight-charge-slip,.freight-charge-slip *{visibility:visible!important}.freight-charge-slip{display:block!important;position:fixed;inset:0;background:white;color:#111;padding:36px;font:14px Arial,sans-serif}.freight-charge-slip table{width:100%;border-collapse:collapse}.freight-charge-slip td{padding:7px;border-bottom:1px solid #ddd}.freight-charge-slip .right{text-align:right;font-family:monospace}}`}</style>
      <section className="freight-charge-slip max-w-3xl rounded-lg border border-border bg-card p-6" aria-label="Printable customer freight charge notice">
        <div className="flex items-start justify-between border-b pb-4"><div><h2 className="text-xl font-bold">NatEx · Customer Freight Charge</h2><p className="mt-1 text-sm text-muted-foreground">Retail parcel booking · separate from COD</p></div><div className="text-right"><p className="font-mono font-semibold">{charge.code}</p><p className="text-xs">{dateTime(charge.createdAt)}</p></div></div>
        <div className="grid grid-cols-2 gap-4 py-4 text-sm"><div><p className="font-semibold">Sender</p><p>{charge.senderName}</p><p>{charge.senderPhone}</p><p>{charge.senderAddress ?? ""}</p></div><div><p className="font-semibold">Recipient</p><p>{charge.recipientName}</p><p>{charge.recipientPhone}</p><p>{charge.destinationAddress}</p></div></div>
        <table><tbody><tr><td>AWB</td><td className="right">{charge.awb}</td></tr><tr><td>Booked at</td><td className="right">{charge.branchName}</td></tr><tr><td>Courier freight charge</td><td className="right">{money(charge.amountCents)}</td></tr><tr><td>Freight payer</td><td className="right">{charge.payer === "sender" ? "Sender · counter" : "Recipient · delivery"}</td></tr><tr><td>Paid so far</td><td className="right">{money(paidCents)}</td></tr><tr><td>Balance due</td><td className="right">{money(dueCents)}</td></tr><tr><td>Payment status</td><td className="right">{dueCents <= 0 ? "Settled" : "Due"}</td></tr><tr><td>COD</td><td className="right">Rs. 0.00 · not a COD parcel</td></tr></tbody></table>
        <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">A recipient-paid charge is collected by the Rider at delivery. This notice records the courier freight charge; a separate receipt is issued after payment. This is not a VAT tax invoice.</p>
      </section>
    </>
  );
}
