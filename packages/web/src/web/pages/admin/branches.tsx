import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, coords, fromE6, toE6 } from "@/lib/format";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Page, ErrorNote } from "@/components/natex/page";
import { DataTable, MonoCell, type Column } from "@/components/natex/data-table";
import { AddressFields } from "@/components/natex/address-fields";
import { addressPartsFromLegacy, EMPTY_ADDRESS, formatAddress, isCompleteAddress, type AddressParts } from "@/lib/address";
import { useAuth } from "@/components/auth-provider";

/**
 * Branch network (§5 identity). A branch is the unit of row-level scoping:
 * every parcel, merchant and manifest is accountable to one. Coordinates are
 * geocoded once and stored as microdegrees, never re-sent to a maps provider.
 */

interface BranchRow {
  id: string;
  code: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  type: string;
  status: "active" | "inactive";
  counterRateCardId: string | null;
  createdAt: string | Date;
}

export default function AdminBranches() {
  const { session } = useAuth();
  const isAdmin = session!.user.role === "admin";
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<BranchRow | null>(null);

  const branches = useQuery(orpc.identity.listBranches.queryOptions({ input: { includeInactive: true } }));
  const zones = useQuery(orpc.routing.listZones.queryOptions({ input: {} }));

  const zoneCount = React.useCallback(
    (branchId: string) => (zones.data ?? []).filter((z) => z.branchId === branchId).length,
    [zones.data],
  );

  const columns: Column<BranchRow>[] = [
    { key: "code", header: "Code", width: "w-[100px]", cell: (r) => <MonoCell>{r.code}</MonoCell> },
    { key: "name", header: "Branch", cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: "type",
      header: "Type",
      width: "w-[100px]",
      cell: (r) => (
        <Badge variant={r.type === "hub" ? "brand" : "outline"}>
          {r.type === "hub" ? "Hub" : "Branch"}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "w-[100px]",
      cell: (r) => <Badge variant={r.status === "active" ? "good" : "warn"}>{r.status === "active" ? "Active" : "Inactive"}</Badge>,
    },
    {
      key: "address",
      header: "Address",
      cell: (r) => <span className="truncate text-muted-foreground">{r.address}</span>,
    },
    {
      key: "geo",
      header: "Geocode",
      width: "w-[170px]",
      className: "font-mono text-[11px] text-muted-foreground",
      cell: (r) => coords(r.lat, r.lng),
    },
    {
      key: "zones",
      header: "Zones",
      align: "right",
      width: "w-[90px]",
      className: "font-mono",
      cell: (r) => (
        <span className={zoneCount(r.id) ? "" : "text-status-warn"}>{zoneCount(r.id)}</span>
      ),
    },
    {
      key: "since",
      header: "Opened",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.createdAt),
    },
  ];

  return (
    <Page
      title="Branches"
      description={`The branch network. Inactive branches remain visible for history but cannot receive new work. Missing coordinates stay unknown and are skipped for distance calculations.${isAdmin ? " Open a row to edit it; the code is permanent." : ""}`}
      actions={
        isAdmin ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Add branch
          </Button>
        ) : null
      }
      bleed
    >
      <DataTable
        columns={columns}
        rows={(branches.data ?? []) as unknown as BranchRow[]}
        rowKey={(r) => r.id}
        onRowClick={isAdmin ? (r) => setEditing(r) : undefined}
        loading={branches.isLoading}
        error={
          branches.error ? apiMessage(branches.error, "The branch network is unavailable.") : null
        }
        emptyTitle="No branch exists yet"
        emptyDescription="At least one branch is required before a user or merchant can be created — every record is scoped to one."
        className="min-h-0 flex-1"
      />
      {isAdmin ? <CreateBranchDialog open={creating} onOpenChange={setCreating} /> : null}
      {isAdmin && editing ? (
        <EditBranchDialog key={editing.id} branch={editing} onClose={() => setEditing(null)} />
      ) : null}
    </Page>
  );
}

function CreateBranchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
    code: "",
    name: "",
    address: { ...EMPTY_ADDRESS },
    lat: "",
    lng: "",
    type: "branch" as "hub" | "branch",
  });
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const create = useMutation({
    ...orpc.identity.createBranch.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      setForm((f) => ({ ...f, code: "", name: "", address: { ...EMPTY_ADDRESS }, lat: "", lng: "" }));
      onOpenChange(false);
    },
    onError: (error) => setProblem(apiMessage(error, "This branch could not be created.")),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const lat = Number(form.lat);
  const lng = Number(form.lng);
  const coordsValid = (form.lat === "" || (Number.isFinite(lat) && lat >= -90 && lat <= 90)) &&
    (form.lng === "" || (Number.isFinite(lng) && lng >= -180 && lng <= 180));
  const ready =
    form.code.trim().length >= 2 &&
    form.name.trim().length >= 2 &&
    isCompleteAddress(form.address) &&
    coordsValid;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a branch"
      description="The code appears on manifests and bag seals, so keep it short and permanent."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            pending={create.isPending}
            onClick={() =>
              create.mutate({
                code: form.code.trim().toUpperCase(),
                name: form.name.trim(),
                address: formatAddress(form.address),
                lat: form.lat === "" ? null : lat,
                lng: form.lng === "" ? null : lng,
                type: form.type,
              })
            }
          >
            Create branch
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Code" hint="2–12 characters, e.g. CMB01.">
            <Input
              value={form.code}
              onChange={(e) => set("code", e.target.value.toUpperCase())}
              className="font-mono"
            />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              onChange={(e) => set("type", e.target.value as "hub" | "branch")}
            >
              <option value="branch">Branch</option>
              <option value="hub">Hub</option>
            </Select>
          </Field>
        </div>
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <AddressFields title="Branch address" value={form.address} onChange={(address) => set("address", address)} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Latitude" hint="Optional; decimal degrees.">
            <Input
              value={form.lat}
              onChange={(e) => set("lat", e.target.value)}
              inputMode="decimal"
              placeholder="6.9344"
              className="font-mono"
            />
          </Field>
          <Field label="Longitude" hint="Optional; decimal degrees.">
            <Input
              value={form.lng}
              onChange={(e) => set("lng", e.target.value)}
              inputMode="decimal"
              placeholder="79.8428"
              className="font-mono"
            />
          </Field>
        </div>
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          Coordinates are optional. Leave them blank when unknown; missing coordinates are
          stored as null and are not used to estimate nearest-branch distances. Saved
          coordinates are stored as integer microdegrees and are never re-geocoded.
        </p>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

function EditBranchDialog({ branch, onClose }: { branch: BranchRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const rateCards = useQuery(orpc.rateCards.list.queryOptions());
  const [name, setName] = React.useState(branch.name);
  const [address, setAddress] = React.useState<AddressParts>(() => addressPartsFromLegacy(branch.address));
  const [lat, setLat] = React.useState(() => String(fromE6(branch.lat) ?? ""));
  const [lng, setLng] = React.useState(() => String(fromE6(branch.lng) ?? ""));
  const [type, setType] = React.useState(branch.type as "hub" | "branch");
  const [counterRateCardId, setCounterRateCardId] = React.useState(branch.counterRateCardId ?? "");
  const [problem, setProblem] = React.useState<string | null>(null);

  const save = useMutation({
    ...orpc.identity.updateBranch.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => setProblem(apiMessage(error, "This branch could not be saved.")),
  });
  const changeStatus = useMutation({
    ...orpc.identity.setBranchStatus.mutationOptions(),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onClose();
    },
    onError: (error) => setProblem(apiMessage(error, "This branch status could not be changed.")),
  });

  const latN = Number(lat);
  const lngN = Number(lng);
  const patch: { id: string; name?: string; address?: string; lat?: number | null; lng?: number | null; type?: "hub" | "branch"; counterRateCardId?: string | null } = {
    id: branch.id,
  };
  if (name.trim() !== branch.name) patch.name = name.trim();
  const formattedAddress = formatAddress(address);
  if (formattedAddress !== branch.address) patch.address = formattedAddress;
  if (lat === "" && branch.lat !== null) patch.lat = null;
  else if (lat !== "" && Number.isFinite(latN) && toE6(latN) !== branch.lat) patch.lat = latN;
  if (lng === "" && branch.lng !== null) patch.lng = null;
  else if (lng !== "" && Number.isFinite(lngN) && toE6(lngN) !== branch.lng) patch.lng = lngN;
  if (type !== branch.type) patch.type = type;
  if (counterRateCardId !== (branch.counterRateCardId ?? "")) patch.counterRateCardId = counterRateCardId || null;
  const coordsValid = (lat === "" || (Number.isFinite(latN) && latN >= -90 && latN <= 90)) &&
    (lng === "" || (Number.isFinite(lngN) && lngN >= -180 && lngN <= 180));
  const valid =
    name.trim().length >= 2 &&
    isCompleteAddress(address) &&
    coordsValid;
  const changed = Object.keys(patch).length > 1;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${branch.code}`}
      description="The branch code is permanent. Coordinates are optional; clear a saved value to explicitly remove it. Deactivation keeps existing records and history intact."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            variant={branch.status === "active" ? "destructive" : "outline"}
            pending={changeStatus.isPending}
            onClick={() => {
              setProblem(null);
              changeStatus.mutate({ id: branch.id, status: branch.status === "active" ? "inactive" : "active" });
            }}
          >
            {branch.status === "active" ? "Deactivate branch" : "Reactivate branch"}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!valid || !changed}
              pending={save.isPending}
              onClick={() => {
                setProblem(null);
                save.mutate(patch);
              }}
            >
              Save branch
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as "hub" | "branch")}>
              <option value="branch">Branch</option>
              <option value="hub">Hub</option>
            </Select>
          </Field>
        </div>
        <AddressFields title="Branch address" value={address} onChange={setAddress} />
        <Field
          label="Counter booking rate card"
          hint="This approved, published tariff prices walk-in parcels. Same origin district uses the local band; other districts use outstation."
        >
          <Select value={counterRateCardId} onChange={(event) => setCounterRateCardId(event.target.value)}>
            <option value="">Not configured</option>
            {(rateCards.data ?? []).map((card) => (
              <option key={card.id} value={card.id} disabled={!card.counterReady}>
                {card.code} — {card.name}{card.placeholder ? " · placeholder" : !card.activeVersion ? " · no published version" : !card.counterReady ? " · incomplete Counter bands/prices" : ` · v${card.activeVersion.version}`}
              </option>
            ))}
          </Select>
        </Field>
        {!rateCards.isLoading && !(rateCards.data ?? []).some((card) => card.counterReady) ? (
          <p className="rounded-md border border-status-warn/30 bg-status-warn/5 px-3 py-2 text-[12px] text-muted-foreground">
            No approved published rate card is available yet. Complete and publish one in Administration → Rate cards before accepting Counter bookings.
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Latitude" hint="Optional; decimal degrees. Clear to remove this saved coordinate.">
            <Input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" className="font-mono" />
          </Field>
          <Field label="Longitude" hint="Optional; decimal degrees. Clear to remove this saved coordinate.">
            <Input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" className="font-mono" />
          </Field>
        </div>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}
