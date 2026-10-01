import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc, client, apiMessage, apiDetails } from "@/lib/api";
import {
  coords,
  date,
  dateTime,
  grams,
  humanise,
  money,
} from "@/lib/format";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/dialog";
import { StatusPill } from "./status-pill";
import { Timeline } from "./timeline";
import { KeyValue, KeyValueGrid, ErrorNote } from "./page";
import { statusColour } from "@/lib/status";
import { ulid } from "@/lib/ulid";

/**
 * Parcel detail drawer — 480px, over a dimmed board (design.md). Shows the
 * parcel, its append-only timeline, and only the transitions the *server* says
 * this caller may command (`commandable` from parcels.get); the UI never holds
 * its own copy of the transition table.
 */
export function ParcelDrawer({
  awb,
  onOpenChange,
}: {
  awb: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [notes, setNotes] = React.useState("");
  const [pendingTo, setPendingTo] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const detail = useQuery({
    ...orpc.parcels.get.queryOptions({ input: { awbOrId: awb ?? "" } }),
    enabled: Boolean(awb),
  });

  const transition = useMutation({
    mutationFn: (to: string) =>
      client.parcels.transition({
        awbOrId: awb!,
        to,
        notes: notes.trim() || null,
        // A client-minted id makes a retried command idempotent (§7).
        clientId: ulid(),
      }),
    onSuccess: () => {
      setNotes("");
      setFailure(null);
      setPendingTo(null);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      // An illegal transition is stated in plain language, naming the current
      // state and the legal options — never a raw 422 (design.md).
      const details = apiDetails(error);
      const legal = Array.isArray(details.legalNext)
        ? (details.legalNext as string[]).map(humanise).join(", ")
        : null;
      setFailure(
        [apiMessage(error, "That change was refused."), legal ? `Legal next: ${legal}.` : null]
          .filter(Boolean)
          .join(" "),
      );
      setPendingTo(null);
    },
  });

  const parcel = detail.data?.parcel;
  const timeline = detail.data?.timeline ?? [];
  const commandable = detail.data?.commandable ?? [];

  return (
    <>
      <Drawer
        open={Boolean(awb)}
        onOpenChange={(open) => {
          if (!open) {
            setNotes("");
            setFailure(null);
            transition.reset();
          }
          onOpenChange(open);
        }}
        title={<span className="font-mono">{awb ?? ""}</span>}
        subtitle={
          parcel ? `${parcel.consigneeName} · booked ${date(parcel.createdAt)}` : "Loading…"
        }
        footer={
          detail.data ? (
            <CommandBar
              commandable={detail.data.commandable}
              legalNext={detail.data.legalNext}
              status={parcel!.status}
              pendingTo={transition.isPending ? pendingTo : null}
              onCommand={(to) => setPendingTo(to)}
            />
          ) : null
        }
      >
        {detail.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-4 rounded bg-muted-foreground/15" aria-hidden />
            ))}
          </div>
        ) : detail.error ? (
          <ErrorNote>{apiMessage(detail.error, "This parcel could not be loaded.")}</ErrorNote>
        ) : parcel ? (
          <div className="space-y-6">
            <div
              className="flex items-center gap-3 rounded-lg border px-3.5 py-3"
              style={{
                borderColor: `color-mix(in srgb, ${statusColour(parcel.status)} 35%, transparent)`,
                backgroundColor: `color-mix(in srgb, ${statusColour(parcel.status)} 8%, transparent)`,
              }}
            >
              <StatusPill status={parcel.status} size="lg" />
              <span className="text-[12px] text-muted-foreground">
                since {dateTime(parcel.updatedAt)}
              </span>
            </div>

            {failure ? <ErrorNote>{failure}</ErrorNote> : null}

            <section>
              <h3 className="label-xs mb-3 text-muted-foreground">Consignment</h3>
              <KeyValueGrid>
                <KeyValue label="Weight">{grams(parcel.weightGrams)}</KeyValue>
                <KeyValue label="Dimensions">
                  {parcel.lengthCm && parcel.widthCm && parcel.heightCm
                    ? `${parcel.lengthCm} × ${parcel.widthCm} × ${parcel.heightCm} cm`
                    : "—"}
                </KeyValue>
                <KeyValue label="Declared value" mono>
                  {money(parcel.declaredValueCents)}
                </KeyValue>
                <KeyValue label="COD to collect" mono>
                  {money(parcel.codAmountCents)}
                </KeyValue>
                <KeyValue label="Delivery attempts" mono>
                  {parcel.deliveryAttempts}
                </KeyValue>
                <KeyValue label="COD locked">
                  {parcel.codLockedAt ? dateTime(parcel.codLockedAt) : "Not locked"}
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section>
              <h3 className="label-xs mb-3 text-muted-foreground">Pickup</h3>
              <KeyValueGrid columns={1}>
                <KeyValue label="Origin address">{parcel.originAddress}</KeyValue>
                <KeyValue label="Origin coordinates" mono>
                  {coords(parcel.originLat, parcel.originLng)}
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section>
              <h3 className="label-xs mb-3 text-muted-foreground">Consignee</h3>
              <KeyValueGrid columns={1}>
                <KeyValue label="Name">{parcel.consigneeName}</KeyValue>
                <KeyValue label="Phone" mono>
                  {parcel.consigneePhone}
                </KeyValue>
                <KeyValue label="Destination address">{parcel.destAddress}</KeyValue>
                <KeyValue label="Destination coordinates" mono>
                  {coords(parcel.destLat, parcel.destLng)}
                </KeyValue>
                <KeyValue label="Destination zone" mono>
                  {parcel.destZoneId ?? "Unassigned"}
                </KeyValue>
              </KeyValueGrid>
            </section>

            <section>
              <div className="mb-3 flex items-baseline justify-between">
                <h3 className="label-xs text-muted-foreground">Custody timeline</h3>
                <span className="text-[11px] text-muted-foreground">
                  append-only · {timeline.length} events
                </span>
              </div>
              <Timeline events={timeline} />
            </section>

            {commandable.length > 0 ? (
              <Field label="Note for the next change" hint="Written onto the custody event.">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optional — e.g. reason for hold"
                  maxLength={500}
                />
              </Field>
            ) : null}
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={Boolean(pendingTo)}
        onOpenChange={(open) => {
          if (!open) setPendingTo(null);
        }}
        title={`Move to ${pendingTo ? humanise(pendingTo) : ""}`}
        objectName={awb ?? ""}
        destructive={pendingTo === "Cancelled" || pendingTo === "Lost" || pendingTo === "Damaged"}
        confirmLabel={`Record ${pendingTo ? humanise(pendingTo) : ""}`}
        pending={transition.isPending}
        body={
          <>
            This appends a custody event and cannot be undone — a correction is a new
            event, never an edit.
            {notes.trim() ? (
              <span className="mt-2 block rounded bg-muted px-2 py-1">{notes.trim()}</span>
            ) : null}
          </>
        }
        onConfirm={() => {
          if (pendingTo) transition.mutate(pendingTo);
        }}
      />
    </>
  );
}

function CommandBar({
  commandable,
  legalNext,
  status,
  pendingTo,
  onCommand,
}: {
  commandable: readonly string[];
  legalNext: readonly string[];
  status: string;
  pendingTo: string | null;
  onCommand: (to: string) => void;
}) {
  if (commandable.length === 0) {
    const deferred = legalNext.filter((s) => !commandable.includes(s));
    return (
      <p className="text-[12px] text-muted-foreground">
        Nothing for you to do here. This parcel is {humanise(status)}
        {deferred.length > 0
          ? ` — the next step (${deferred.map(humanise).join(", ")}) belongs to another role, or is made by its own workflow (proof of delivery at the door, a sealed bag on a departing trip).`
          : " and has reached a terminal state."}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {commandable.map((to) => (
        <Button
          key={to}
          size="sm"
          variant={
            to === "Cancelled" || to === "Lost" || to === "Damaged" ? "destructive" : "default"
          }
          pending={pendingTo === to}
          onClick={() => onCommand(to)}
        >
          {humanise(to)}
        </Button>
      ))}
    </div>
  );
}
