import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { Field, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Page, Card, ErrorNote } from "@/components/natex/page";
import { MetricTile } from "@/components/natex/metric-tile";
import { StatusPill } from "@/components/natex/status-pill";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";

/**
 * Hub receipt (§5). A rider comes back with a bag; ops scans it in and every
 * parcel moves PickedUp → AtOriginHub through the same state machine choke
 * point the app uses. Anything not in PickedUp is refused and named.
 */

interface PickedUpRow {
  id: string;
  awb: string;
  status: string;
  consigneeName: string;
  destAddress: string;
}

export default function OpsHubReceipt() {
  const queryClient = useQueryClient();
  const [text, setText] = React.useState("");
  const [result, setResult] = React.useState<{
    received: string[];
    rejected: { awb: string; reason: string }[];
  } | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  // What the branch is still waiting to receive.
  const outstanding = useQuery(
    orpc.parcels.list.queryOptions({
      input: { page: 1, pageSize: 50, status: ["PickedUp"] },
    }),
  );

  const awbs = React.useMemo(
    () =>
      Array.from(
        new Set(
          text
            .split(/[\s,;]+/)
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        ),
      ),
    [text],
  );

  const receive = useMutation({
    ...orpc.collection.receiveAtHub.mutationOptions(),
    onSuccess: (data) => {
      setProblem(null);
      setResult(data);
      setText("");
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      setResult(null);
      setProblem(apiMessage(error, "The hub receipt could not be recorded."));
    },
  });

  const columns: Column<PickedUpRow>[] = [
    { key: "awb", header: "AWB", width: "w-[150px]", cell: (r) => <MonoCell>{r.awb}</MonoCell> },
    {
      key: "status",
      header: "Status",
      width: "w-[130px]",
      cell: (r) => <StatusPill status={r.status} />,
    },
    { key: "consignee", header: "Consignee", cell: (r) => r.consigneeName },
    {
      key: "dest",
      header: "Destination",
      cell: (r) => <span className="truncate text-muted-foreground">{r.destAddress}</span>,
    },
  ];

  const rows = (outstanding.data?.rows ?? []) as unknown as PickedUpRow[];

  return (
    <Page
      title="Hub receipt"
      description="Scan a returning rider's bag into the origin hub. Each AWB runs through the parcel state machine individually, so a parcel in the wrong state is refused by name instead of failing the whole bag."
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card
          title="In your branch's custody"
          description="Parcels currently Picked up and not yet received at a hub."
          bodyClassName="p-0"
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={outstanding.isLoading}
            error={
              outstanding.error
                ? apiMessage(outstanding.error, "Outstanding parcels are unavailable.")
                : null
            }
            emptyTitle="Nothing is out with a rider"
            emptyDescription="Every collected parcel has already been received at a hub. Parcels appear here once a pickup handover completes."
            onRowClick={(r) =>
              setText((current) =>
                current.includes(r.awb) ? current : `${current}${current ? "\n" : ""}${r.awb}`,
              )
            }
            className="rounded-none border-0"
          />
        </Card>

        <div className="flex flex-col gap-4">
          <MetricTile
            label="Awaiting receipt"
            value={outstanding.data?.total ?? "—"}
            hint="Picked up, not yet at a hub."
          />

          <Card title="Scan into hub">
            <div className="flex flex-col gap-4">
              <Field
                label="AWBs"
                hint="One per line. Click a row on the left to add it."
              >
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={"NX0000000001\nNX0000000002"}
                  className="min-h-[160px] font-mono text-[13px]"
                />
              </Field>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[12px] text-muted-foreground">
                  {awbs.length} AWB{awbs.length === 1 ? "" : "s"}
                </span>
                <Button
                  disabled={awbs.length === 0}
                  pending={receive.isPending}
                  onClick={() => receive.mutate({ awbs })}
                >
                  <PackageCheck aria-hidden />
                  Receive at hub
                </Button>
              </div>
              {problem ? <ErrorNote>{problem}</ErrorNote> : null}
            </div>
          </Card>

          {result ? (
            <Card title="Last receipt">
              <div className="flex flex-col gap-3">
                <p className="text-[13px]">
                  <span className="font-mono font-medium text-status-good">
                    {result.received.length}
                  </span>{" "}
                  received at hub.
                  {result.rejected.length ? (
                    <>
                      {" "}
                      <span className="font-mono font-medium text-status-warn">
                        {result.rejected.length}
                      </span>{" "}
                      refused.
                    </>
                  ) : null}
                </p>
                {result.received.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">Received</p>
                    <p className="font-mono text-[12px] leading-relaxed text-status-good">
                      {result.received.join(", ")}
                    </p>
                  </div>
                ) : null}
                {result.rejected.length ? (
                  <div>
                    <p className="label-xs mb-1.5 text-muted-foreground">Refused</p>
                    <ul className="flex flex-col gap-1.5">
                      {result.rejected.map((r) => (
                        <li key={r.awb} className="text-[12px]">
                          <span className="font-mono font-medium">{r.awb}</span>
                          <span className="text-muted-foreground"> — {r.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
