import * as React from "react";
import { PackageCheck, AlertTriangle } from "lucide-react";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Page, Card, ErrorNote, SuccessNote, KeyValue, KeyValueGrid } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { dateTime, since } from "@/lib/format";
import { useAuth } from "@/components/auth-provider";
import { BagStatusBadge } from "./bagging";
import { useBag, useBagReceive, useInboundBags, useTransportCounts } from "@/queries/transport";

/**
 * Inbound bags — the two-party hub receipt (§7).
 *
 * The receipt takes four inputs a human has to supply honestly: the seal number
 * actually found on the bag, the AWBs actually scanned out of it, who handed it
 * over and who took it. Any disagreement with the origin hub's manifest — a
 * wrong seal, a missing parcel, a parcel that was never manifested — is written
 * out as an exception rather than corrected quietly.
 *
 * Note this is the *hub-to-hub* receipt. The rider-bag receipt (PickedUp →
 * AtOriginHub) is the separate Hub receipt screen.
 */

interface ReceiptResult {
  received: { awb: string }[];
  duplicates: { awb: string }[];
  missing: { awb: string; reason: string }[];
  unexpected: { awb: string; reason: string }[];
  sealMatched: boolean;
  exceptionsRaised: number;
}

interface InboundRow {
  id: string;
  code: string;
  sealNumber: string | null;
  status: string;
  itemCount: number;
  originHubName: string;
  destHubName: string;
  tripCode: string | null;
  tripStatus: string | null;
  sealedAt: Date | string | null;
}

export default function OpsInbound() {
  const { session } = useAuth();

  const [bagId, setBagId] = React.useState<string | null>(null);
  const [scanText, setScanText] = React.useState("");
  const [seal, setSeal] = React.useState("");
  const [releasedBy, setReleasedBy] = React.useState("");
  const [receivedBy, setReceivedBy] = React.useState(session?.user.name ?? "");
  const [result, setResult] = React.useState<ReceiptResult | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const counts = useTransportCounts();
  const inbound = useInboundBags();
  const bag = useBag(bagId);
  const detail = bag.data ?? null;

  const scanned = React.useMemo(
    () =>
      Array.from(
        new Set(
          scanText
            .split(/[\s,;]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        ),
      ),
    [scanText],
  );

  const receive = useBagReceive({
    onSuccess: (data) => {
      setResult(data as ReceiptResult);
      setProblem(null);
      setScanText("");
      setSeal("");
      setReleasedBy("");
      setBagId(null);
    },
    onError: (message) => {
      setResult(null);
      setProblem(message);
    },
  });

  const columns: Column<InboundRow>[] = [
    { key: "code", header: "Bag", width: "w-[130px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    {
      key: "seal",
      header: "Seal on manifest",
      width: "w-[140px]",
      cell: (r) => <MonoCell>{r.sealNumber ?? "—"}</MonoCell>,
    },
    { key: "from", header: "From", cell: (r) => r.originHubName },
    {
      key: "trip",
      header: "Trip",
      width: "w-[130px]",
      cell: (r) => <MonoCell>{r.tripCode ?? "—"}</MonoCell>,
    },
    {
      key: "items",
      header: "Manifested",
      width: "w-[110px]",
      align: "right",
      cell: (r) => <MonoCell>{r.itemCount}</MonoCell>,
    },
    {
      key: "sealed",
      header: "Sealed",
      width: "w-[120px]",
      cell: (r) => <span className="text-muted-foreground">{since(r.sealedAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (r) => <BagStatusBadge status={r.status} />,
    },
  ];

  const rows = (inbound.data ?? []) as unknown as InboundRow[];
  const manifest = (detail?.items ?? []).filter((i) => !i.removedAt);
  const sealDisagrees =
    Boolean(seal.trim()) &&
    Boolean(detail?.bag.sealNumber) &&
    seal.trim().toUpperCase() !== detail!.bag.sealNumber!.toUpperCase();

  return (
    <Page
      title="Inbound bags"
      description="Receive a bag that has arrived from another hub. Enter the seal you actually found and scan what is actually inside — the system compares both against the origin hub's manifest and raises an exception for every disagreement."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricTile
          label="Bags inbound"
          value={rows.length}
          hint="In transit to your hub, not yet received."
        />
        <MetricTile
          label="Awaiting reconciliation"
          value={counts.data?.bagsAwaitingReconciliation ?? "—"}
          hint="Received with a variance still open."
        />
        <MetricTile
          label="Open exceptions"
          value={counts.data?.openExceptions ?? "—"}
          hint="Across your branch."
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card
            title="Expected at your hub"
            description="Click a bag to open its receipt."
            bodyClassName="p-0"
          >
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              loading={inbound.isLoading}
              error={inbound.error ? "The inbound queue is unavailable right now." : null}
              emptyTitle="Nothing inbound"
              emptyDescription="Bags appear here once the origin hub seals them and despatches the linehaul trip carrying them to you."
              onRowClick={(r) => {
                setBagId(r.id);
                setResult(null);
                setProblem(null);
              }}
              rowClassName={(r) => (r.id === bagId ? "bg-brand/8" : undefined)}
              className="rounded-none border-0"
            />
          </Card>

          {detail ? (
            <Card
              title={`Manifest for ${detail.bag.code}`}
              description={`What ${detail.originHubName} says it sent. Scan the bag out against this.`}
              bodyClassName="p-0"
            >
              <ul className="divide-y divide-border">
                {manifest.map((i) => {
                  const hit = scanned.includes(i.awb.toUpperCase());
                  return (
                    <li key={i.id} className="flex items-center gap-3 px-5 py-2.5">
                      <span className="flex-1 font-mono text-[13px] font-medium">{i.awb}</span>
                      <span className="text-[12px] text-muted-foreground">
                        bagged {dateTime(i.scannedAt)}
                      </span>
                      <Badge variant={hit ? "good" : "muted"}>
                        {hit ? "Scanned" : "Not scanned"}
                      </Badge>
                    </li>
                  );
                })}
                {manifest.length === 0 ? (
                  <li className="px-5 py-5 text-[13px] text-muted-foreground">
                    This bag's manifest is empty, which is itself a variance — receive it and the
                    exception will say so.
                  </li>
                ) : null}
              </ul>
            </Card>
          ) : null}

          {result ? (
            <Card
              title="Last receipt"
              description="The record written. Variances are already in the Ops exception queue."
            >
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={result.sealMatched ? "good" : "bad"}>
                    {result.sealMatched ? "Seal matched" : "Seal mismatch"}
                  </Badge>
                  <Badge variant="good">{result.received.length} received</Badge>
                  <Badge variant={result.missing.length ? "bad" : "muted"}>
                    {result.missing.length} missing
                  </Badge>
                  <Badge variant={result.unexpected.length ? "warn" : "muted"}>
                    {result.unexpected.length} unexpected
                  </Badge>
                  <Badge variant={result.exceptionsRaised ? "warn" : "muted"}>
                    {result.exceptionsRaised} exception
                    {result.exceptionsRaised === 1 ? "" : "s"} raised
                  </Badge>
                </div>
                {result.received.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">
                      Received — now at your hub
                    </p>
                    <p className="font-mono text-[12px] leading-relaxed text-status-good">
                      {result.received.map((r) => r.awb).join(", ")}
                    </p>
                  </div>
                ) : null}
                {result.missing.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-status-bad">
                      Manifested but never scanned here
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {result.missing.map((m) => (
                        <li key={m.awb} className="text-[12px]">
                          <span className="font-mono font-medium">{m.awb}</span>
                          <span className="text-muted-foreground"> — {m.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {result.unexpected.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-status-warn">
                      Scanned here but not on the manifest
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {result.unexpected.map((m) => (
                        <li key={m.awb} className="text-[12px]">
                          <span className="font-mono font-medium">{m.awb}</span>
                          <span className="text-muted-foreground"> — {m.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          {detail ? (
            <Card
              title={`Receive ${detail.bag.code}`}
              description={`${detail.originHubName} → ${detail.destHubName}`}
            >
              <div className="flex flex-col gap-4">
                <KeyValueGrid>
                  <KeyValue label="Manifested" mono>
                    {manifest.length}
                  </KeyValue>
                  <KeyValue label="Scanned now" mono>
                    {scanned.length}
                  </KeyValue>
                </KeyValueGrid>

                <Field
                  label="Seal found on the bag"
                  hint="Type what is physically written on the seal, not what the manifest says."
                  error={sealDisagrees ? "This does not match the manifest — a seal mismatch exception will be raised." : null}
                >
                  <Input
                    value={seal}
                    onChange={(e) => setSeal(e.target.value.toUpperCase())}
                    placeholder="SL-004821"
                    className="font-mono"
                  />
                </Field>

                <Field label="AWBs scanned out of the bag" hint="One per line.">
                  <Textarea
                    value={scanText}
                    onChange={(e) => setScanText(e.target.value)}
                    placeholder={"NX0000000001\nNX0000000002"}
                    className="min-h-[150px] font-mono text-[13px]"
                  />
                </Field>

                <Field label="Released by" hint="The driver or hub staffer handing the bag over.">
                  <Input
                    value={releasedBy}
                    onChange={(e) => setReleasedBy(e.target.value)}
                    placeholder="Driver's name"
                  />
                </Field>

                <Field label="Received by" hint="You, unless someone else physically took it.">
                  <Input
                    value={receivedBy}
                    onChange={(e) => setReceivedBy(e.target.value)}
                    placeholder="Your name"
                  />
                </Field>

                <Button
                  disabled={releasedBy.trim().length < 2 || !detail.canReceive}
                  pending={receive.isPending}
                  onClick={() =>
                    receive.mutate({
                      bagId: detail.bag.id,
                      scannedAwbs: scanned,
                      sealNumber: seal.trim() || null,
                      releasedByName: releasedBy.trim(),
                      receivedByName: receivedBy.trim() || null,
                    })
                  }
                >
                  <PackageCheck aria-hidden />
                  Record receipt
                </Button>

                {!detail.canReceive ? (
                  <ErrorNote>
                    This bag cannot be received at your branch — it is either not in transit, or it
                    is addressed to a different hub.
                  </ErrorNote>
                ) : null}

                {scanned.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    Recording a receipt with nothing scanned is allowed and will raise a missing
                    exception for every manifested parcel. Do it only if the bag really was empty.
                  </p>
                ) : null}

                {problem ? <ErrorNote>{problem}</ErrorNote> : null}
              </div>
            </Card>
          ) : (
            <Card title="No bag selected">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Pick an inbound bag on the left. The receipt needs the seal you found, the labels
                you scanned and the names of both parties before it will record anything.
              </p>
            </Card>
          )}

          <Card title="Why two parties">
            <p className="flex gap-2 text-[13px] leading-relaxed text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-status-warn" aria-hidden />
              <span>
                §7 of the specification forbids a silent correction. Both names are recorded, the
                seal is compared, and every parcel that does not reconcile becomes an exception
                someone has to close by hand.
              </span>
            </p>
          </Card>

          {receive.isSuccess && !problem ? (
            <SuccessNote>Receipt recorded against the bag and every parcel in it.</SuccessNote>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
