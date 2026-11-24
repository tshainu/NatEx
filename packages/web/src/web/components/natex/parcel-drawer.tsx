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
import { Field, Input, Textarea } from "@/components/ui/input";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { StatusPill } from "./status-pill";
import { Timeline } from "./timeline";
import { KeyValue, KeyValueGrid, ErrorNote } from "./page";
import { statusColour } from "@/lib/status";
import { ulid } from "@/lib/ulid";

interface EditForm {
  weightGrams: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  description: string;
  declaredValue: string;
  codAmount: string;
  originAddress: string;
  consigneeName: string;
  consigneePhone: string;
  destAddress: string;
}

const emptyEditForm: EditForm = {
  weightGrams: "",
  lengthCm: "",
  widthCm: "",
  heightCm: "",
  description: "",
  declaredValue: "",
  codAmount: "",
  originAddress: "",
  consigneeName: "",
  consigneePhone: "",
  destAddress: "",
};

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
  const [editOpen, setEditOpen] = React.useState(false);
  const [editForm, setEditForm] = React.useState<EditForm>(emptyEditForm);
  const [editFailure, setEditFailure] = React.useState<string | null>(null);

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

  const edit = useMutation({
    mutationFn: () => {
      const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);
      return client.parcels.editAtOriginHub({
        awbOrId: awb!,
        weightGrams: Number(editForm.weightGrams),
        lengthCm: numberOrNull(editForm.lengthCm),
        widthCm: numberOrNull(editForm.widthCm),
        heightCm: numberOrNull(editForm.heightCm),
        description: editForm.description.trim() || null,
        declaredValueCents: Math.round(Number(editForm.declaredValue) * 100),
        codAmountCents: Math.round(Number(editForm.codAmount) * 100),
        originAddress: editForm.originAddress.trim(),
        originLat: parcel?.originLat ?? null,
        originLng: parcel?.originLng ?? null,
        consigneeName: editForm.consigneeName.trim(),
        consigneePhone: editForm.consigneePhone.trim(),
        destAddress: editForm.destAddress.trim(),
        destLat: parcel?.destLat ?? null,
        destLng: parcel?.destLng ?? null,
        destZoneId: parcel?.destZoneId ?? null,
      });
    },
    onSuccess: () => {
      setEditFailure(null);
      setEditOpen(false);
      void queryClient.invalidateQueries();
    },
    onError: (error) => setEditFailure(apiMessage(error, "The parcel could not be updated.")),
  });

  const parcel = detail.data?.parcel;
  const timeline = detail.data?.timeline ?? [];
  const commandable = detail.data?.commandable ?? [];

  React.useEffect(() => {
    if (!editOpen || !parcel) return;
    setEditForm({
      weightGrams: String(parcel.weightGrams),
      lengthCm: parcel.lengthCm == null ? "" : String(parcel.lengthCm),
      widthCm: parcel.widthCm == null ? "" : String(parcel.widthCm),
      heightCm: parcel.heightCm == null ? "" : String(parcel.heightCm),
      description: parcel.description ?? "",
      declaredValue: ((parcel.declaredValueCents ?? 0) / 100).toFixed(2),
      codAmount: (parcel.codAmountCents / 100).toFixed(2),
      originAddress: parcel.originAddress,
      consigneeName: parcel.consigneeName,
      consigneePhone: parcel.consigneePhone,
      destAddress: parcel.destAddress,
    });
    setEditFailure(null);
  }, [editOpen, parcel]);

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
            <div className="flex flex-wrap items-center gap-2">
              <CommandBar
                commandable={detail.data.commandable}
                legalNext={detail.data.legalNext}
                status={parcel!.status}
                readOnlyReason={detail.data.readOnlyReason}
                canEditAtOriginHub={detail.data.canEditAtOriginHub === true}
                pendingTo={transition.isPending ? pendingTo : null}
                onCommand={(to) => setPendingTo(to)}
                onEdit={() => setEditOpen(true)}
              />
            </div>
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

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          if (!edit.isPending) setEditOpen(open);
        }}
        title="Edit parcel"
        description="Correct booking details before this parcel is bagged. Tracking number, merchant, hub and status cannot be changed."
        className="w-[620px]"
        footer={
          <div className="flex items-center justify-between gap-3">
            {editFailure ? <ErrorNote>{editFailure}</ErrorNote> : <span />}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditOpen(false)} disabled={edit.isPending}>
                Cancel
              </Button>
              <Button pending={edit.isPending} onClick={() => edit.mutate()}>
                Save changes
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weight (grams)">
            <Input type="number" min={1} value={editForm.weightGrams} onChange={(e) => setEditForm((f) => ({ ...f, weightGrams: e.target.value }))} />
          </Field>
          <Field label="Declared value (Rs.)">
            <Input type="number" min={0} step="0.01" value={editForm.declaredValue} onChange={(e) => setEditForm((f) => ({ ...f, declaredValue: e.target.value }))} />
          </Field>
          <Field label="COD amount (Rs.)">
            <Input type="number" min={0} step="0.01" value={editForm.codAmount} onChange={(e) => setEditForm((f) => ({ ...f, codAmount: e.target.value }))} />
          </Field>
          <Field label="Description">
            <Input value={editForm.description} onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))} />
          </Field>
          <Field label="Length (cm)">
            <Input type="number" min={1} value={editForm.lengthCm} onChange={(e) => setEditForm((f) => ({ ...f, lengthCm: e.target.value }))} />
          </Field>
          <Field label="Width (cm)">
            <Input type="number" min={1} value={editForm.widthCm} onChange={(e) => setEditForm((f) => ({ ...f, widthCm: e.target.value }))} />
          </Field>
          <Field label="Height (cm)">
            <Input type="number" min={1} value={editForm.heightCm} onChange={(e) => setEditForm((f) => ({ ...f, heightCm: e.target.value }))} />
          </Field>
          <div />
          <Field label="Origin address" className="col-span-2">
            <Textarea value={editForm.originAddress} onChange={(e) => setEditForm((f) => ({ ...f, originAddress: e.target.value }))} />
          </Field>
          <Field label="Consignee name">
            <Input value={editForm.consigneeName} onChange={(e) => setEditForm((f) => ({ ...f, consigneeName: e.target.value }))} />
          </Field>
          <Field label="Consignee phone">
            <Input value={editForm.consigneePhone} onChange={(e) => setEditForm((f) => ({ ...f, consigneePhone: e.target.value }))} />
          </Field>
          <Field label="Destination address" className="col-span-2">
            <Textarea value={editForm.destAddress} onChange={(e) => setEditForm((f) => ({ ...f, destAddress: e.target.value }))} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

function CommandBar({
  commandable,
  legalNext,
  status,
  readOnlyReason,
  canEditAtOriginHub,
  pendingTo,
  onCommand,
  onEdit,
}: {
  commandable: readonly string[];
  legalNext: readonly string[];
  status: string;
  readOnlyReason: string | null;
  canEditAtOriginHub: boolean;
  pendingTo: string | null;
  onCommand: (to: string) => void;
  onEdit: () => void;
}) {
  const visibleCommandable = commandable.filter((to) => to !== "Bagged");

  if (readOnlyReason) {
    return <p className="text-[12px] text-muted-foreground">{readOnlyReason}</p>;
  }
  if (visibleCommandable.length === 0) {
    const deferred = legalNext.filter((s) => !visibleCommandable.includes(s) && s !== "Bagged");
    return (
      <div className="flex flex-wrap items-center gap-2">
        {canEditAtOriginHub ? (
          <Button
            size="sm"
            variant="outline"
            className="border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-400 dark:bg-sky-950/30 dark:text-sky-200 dark:hover:bg-sky-950/50"
            onClick={onEdit}
          >
            Edit parcel
          </Button>
        ) : null}
        <p className="text-[12px] text-muted-foreground">
          Nothing for you to do here. This parcel is {humanise(status)}
          {deferred.length > 0
            ? ` — the next step (${deferred.map(humanise).join(", ")}) belongs to another role, or is made by its own workflow (proof of delivery at the door, a sealed bag on a departing trip).`
            : " and has reached a terminal state."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEditAtOriginHub ? (
        <Button
          size="sm"
          variant="outline"
          className="border-sky-500 bg-sky-50 text-sky-700 hover:bg-sky-100 dark:border-sky-400 dark:bg-sky-950/30 dark:text-sky-200 dark:hover:bg-sky-950/50"
          onClick={onEdit}
        >
          Edit parcel
        </Button>
      ) : null}
      {visibleCommandable.map((to) => (
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
