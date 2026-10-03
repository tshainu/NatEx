import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { orpc, apiMessage } from "@/lib/api";
import { date, dateTime, coords, humanise } from "@/lib/format";
import { Input, Field, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, ConfirmDialog } from "@/components/ui/dialog";
import { Drawer } from "@/components/ui/drawer";
import { Page, KeyValue, KeyValueGrid, ErrorNote } from "@/components/natex/page";
import { DataTable, type Column } from "@/components/natex/data-table";
import { useAuth } from "@/components/auth-provider";
import {
  EditMerchantDialog,
  OnboardMerchantDialog,
  PortalUsersSection,
  RateCardSection,
} from "./merchant-admin";

/**
 * Merchant register (§5 merchants). Ops and admin manage it; a merchant user
 * sees exactly one row — their own — because the service scopes every read by
 * merchantId, not because this page filters anything.
 */

interface MerchantRow {
  id: string;
  branchId: string;
  name: string;
  vatNo: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  contactName: string;
  contactPhone: string;
  rateCardId: string | null;
  codEnabled: boolean;
  podPolicy: string;
  status: string;
  createdAt: string | Date;
}

export default function Merchants({
  title = "Merchants",
  description = "NatEx's customers. COD eligibility and POD policy are set here and enforced downstream — a merchant with COD disabled cannot book a COD parcel.",
}: {
  title?: string;
  description?: string;
}) {
  const { session } = useAuth();
  const role = session!.user.role;
  const canWrite = role === "ops" || role === "admin";
  const isAdmin = role === "admin";

  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const debounced = useDebounced(search, 250);
  React.useEffect(() => setPage(1), [debounced]);

  const branches = useQuery({
    ...orpc.identity.listBranches.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  const list = useQuery(
    orpc.merchants.list.queryOptions({
      input: { page, pageSize: 25, search: debounced.trim() || undefined },
    }),
  );

  const branchName = React.useCallback(
    (id: string) => branches.data?.find((b) => b.id === id)?.name ?? id,
    [branches.data],
  );

  const columns: Column<MerchantRow>[] = [
    { key: "name", header: "Merchant", cell: (r) => <span className="font-medium">{r.name}</span> },
    {
      key: "branch",
      header: "Branch",
      width: "w-[160px]",
      cell: (r) => <span className="text-muted-foreground">{branchName(r.branchId)}</span>,
    },
    {
      key: "contact",
      header: "Contact",
      width: "w-[200px]",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate">{r.contactName}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {r.contactPhone}
          </p>
        </div>
      ),
    },
    {
      key: "cod",
      header: "COD",
      width: "w-[90px]",
      cell: (r) => (
        <Badge variant={r.codEnabled ? "good" : "muted"}>
          {r.codEnabled ? "Enabled" : "Off"}
        </Badge>
      ),
    },
    {
      key: "pod",
      header: "POD",
      width: "w-[110px]",
      cell: (r) => <span className="text-muted-foreground">{humanise(r.podPolicy)}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "w-[110px]",
      cell: (r) => (
        <Badge variant={r.status === "active" ? "good" : "warn"}>{humanise(r.status)}</Badge>
      ),
    },
    {
      key: "since",
      header: "Since",
      align: "right",
      width: "w-[110px]",
      className: "font-mono text-muted-foreground",
      cell: (r) => date(r.createdAt),
    },
  ];

  return (
    <Page
      title={title}
      description={description}
      actions={
        canWrite ? (
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {isAdmin ? "Onboard merchant" : "Add merchant"}
          </Button>
        ) : null
      }
      bleed
    >
      <DataTable
        columns={columns}
        rows={(list.data?.rows ?? []) as unknown as MerchantRow[]}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error ? apiMessage(list.error, "The merchant register is unavailable.") : null}
        onRowClick={(r) => setOpenId(r.id)}
        emptyTitle="No merchant matches this search"
        emptyDescription="The search matches merchant name and contact phone. Merchants are scoped to your branch."
        filters={
          <Field label="Search" className="w-80">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Merchant name or contact phone"
                className="pl-8"
              />
            </div>
          </Field>
        }
        pagination={{
          page: list.data?.page ?? page,
          pageSize: list.data?.pageSize ?? 25,
          total: list.data?.total ?? 0,
          onPageChange: setPage,
        }}
        className="min-h-0 flex-1"
      />

      <MerchantDrawer
        id={openId}
        canWrite={canWrite}
        isAdmin={isAdmin}
        branches={branches.data ?? []}
        branchName={branchName}
        onOpenChange={(open) => !open && setOpenId(null)}
      />
      {isAdmin ? (
        <OnboardMerchantDialog
          open={creating}
          onOpenChange={setCreating}
          branches={branches.data ?? []}
          defaultBranchId={session!.user.branchId}
          onDone={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      ) : canWrite ? (
        <CreateMerchantDialog
          open={creating}
          onOpenChange={setCreating}
          branches={branches.data ?? []}
          defaultBranchId={session!.user.branchId}
          onCreated={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
        />
      ) : null}
    </Page>
  );
}

// ---------------------------------------------------------------- detail panel

function MerchantDrawer({
  id,
  canWrite,
  isAdmin,
  branches,
  branchName,
  onOpenChange,
}: {
  id: string | null;
  canWrite: boolean;
  isAdmin: boolean;
  branches: { id: string; name: string }[];
  branchName: (id: string) => string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => setProblem(null), [id]);

  const detail = useQuery({
    ...orpc.merchants.get.queryOptions({ input: { id: id ?? "" } }),
    enabled: Boolean(id),
  });

  const parcels = useQuery({
    ...orpc.parcels.list.queryOptions({
      input: { page: 1, pageSize: 5, merchantId: id ?? "" },
    }),
    enabled: Boolean(id),
  });

  const setStatus = useMutation({
    ...orpc.merchants.setStatus.mutationOptions(),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      setConfirming(false);
      setProblem(apiMessage(error, "That change could not be saved."));
    },
  });

  const merchant = detail.data as MerchantRow | undefined;
  const suspending = merchant?.status === "active";

  return (
    <>
      <Drawer
        open={Boolean(id)}
        onOpenChange={onOpenChange}
        title={merchant?.name ?? "Merchant"}
        subtitle={merchant ? branchName(merchant.branchId) : undefined}
        footer={
          canWrite && merchant ? (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setEditing(true)}>
                Edit details
              </Button>
              <Button
                variant={suspending ? "destructive" : "default"}
                className="flex-1"
                onClick={() => setConfirming(true)}
              >
                {suspending ? "Suspend merchant" : "Reactivate merchant"}
              </Button>
            </div>
          ) : null
        }
      >
        {detail.isLoading ? (
          <p className="text-[13px] text-muted-foreground">Loading merchant…</p>
        ) : detail.error ? (
          <ErrorNote>{apiMessage(detail.error, "This merchant is unavailable.")}</ErrorNote>
        ) : merchant ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={merchant.status === "active" ? "good" : "warn"}>
                {humanise(merchant.status)}
              </Badge>
              <Badge variant={merchant.codEnabled ? "brand" : "muted"}>
                {merchant.codEnabled ? "COD enabled" : "COD disabled"}
              </Badge>
              <Badge variant="outline">POD: {humanise(merchant.podPolicy)}</Badge>
            </div>

            {problem ? <ErrorNote>{problem}</ErrorNote> : null}

            <KeyValueGrid>
              <KeyValue label="Contact">{merchant.contactName}</KeyValue>
              <KeyValue label="Phone" mono>
                {merchant.contactPhone}
              </KeyValue>
              <KeyValue label="VAT number" mono>
                {merchant.vatNo ?? "—"}
              </KeyValue>
              <KeyValue label="Onboarded" mono>
                {dateTime(merchant.createdAt)}
              </KeyValue>
              <KeyValue label="Address" className="col-span-2">
                {merchant.address}
              </KeyValue>
              <KeyValue label="Geocode" mono className="col-span-2">
                {coords(merchant.lat, merchant.lng)}
              </KeyValue>
            </KeyValueGrid>

            <RateCardSection merchant={merchant} isAdmin={isAdmin} />
            {isAdmin ? <PortalUsersSection merchantId={merchant.id} /> : null}

            <div>
              <p className="label-xs mb-2 text-muted-foreground">
                Recent parcels ({parcels.data?.total ?? 0} total)
              </p>
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                {(parcels.data?.rows ?? []).map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="font-mono text-[12px] font-medium">{p.awb}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                      {p.consigneeName}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {date(p.createdAt)}
                    </span>
                  </li>
                ))}
                {(parcels.data?.rows ?? []).length === 0 ? (
                  <li className="px-3 py-3 text-[13px] text-muted-foreground">
                    This merchant has not booked a parcel yet.
                  </li>
                ) : null}
              </ul>
            </div>
          </div>
        ) : null}
      </Drawer>

      {merchant && editing ? (
        <EditMerchantDialog
          key={merchant.id}
          merchant={merchant}
          isAdmin={isAdmin}
          branches={branches}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {merchant ? (
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={suspending ? "Suspend this merchant?" : "Reactivate this merchant?"}
          objectName={merchant.name}
          destructive={suspending}
          confirmLabel={suspending ? "Suspend" : "Reactivate"}
          pending={setStatus.isPending}
          body={
            suspending
              ? "A suspended merchant cannot book new parcels. Parcels already in the network keep moving — nothing in custody is affected."
              : "Booking is enabled again immediately."
          }
          onConfirm={() =>
            setStatus.mutate({
              id: merchant.id,
              status: suspending ? "suspended" : "active",
            })
          }
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- create form

function CreateMerchantDialog({
  open,
  onOpenChange,
  branches,
  defaultBranchId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: { id: string; name: string }[];
  defaultBranchId: string;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
    name: "",
    branchId: defaultBranchId,
    vatNo: "",
    address: "",
    contactName: "",
    contactPhone: "",
    codEnabled: true,
    podPolicy: "signature" as "signature" | "otp" | "photo",
  });
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) setProblem(null);
  }, [open]);

  const create = useMutation({
    ...orpc.merchants.create.mutationOptions(),
    onSuccess: (row) => {
      void queryClient.invalidateQueries();
      setForm((f) => ({ ...f, name: "", vatNo: "", address: "", contactName: "", contactPhone: "" }));
      onCreated((row as { id: string }).id);
    },
    onError: (error) =>
      setProblem(apiMessage(error, "This merchant could not be created.")),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const ready =
    form.name.trim().length >= 2 &&
    form.branchId &&
    form.address.trim().length >= 4 &&
    form.contactName.trim().length >= 2 &&
    form.contactPhone.trim().length >= 9;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a merchant"
      description="The branch you choose owns the relationship and scopes every read of this merchant's data."
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
                name: form.name.trim(),
                branchId: form.branchId,
                vatNo: form.vatNo.trim() || null,
                address: form.address.trim(),
                contactName: form.contactName.trim(),
                contactPhone: form.contactPhone.trim(),
                codEnabled: form.codEnabled,
                podPolicy: form.podPolicy,
              })
            }
          >
            Create merchant
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Trading name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Owning branch">
            <Select value={form.branchId} onChange={(e) => set("branchId", e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="VAT number" hint="Optional.">
            <Input
              value={form.vatNo}
              onChange={(e) => set("vatNo", e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
        <Field label="Pickup address">
          <Textarea value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Contact name">
            <Input
              value={form.contactName}
              onChange={(e) => set("contactName", e.target.value)}
            />
          </Field>
          <Field label="Contact phone" hint="Sri Lankan mobile, e.g. 0771234567.">
            <Input
              value={form.contactPhone}
              onChange={(e) => set("contactPhone", e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="COD">
            <Select
              value={form.codEnabled ? "yes" : "no"}
              onChange={(e) => set("codEnabled", e.target.value === "yes")}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>
          <Field label="POD policy" hint="Enforced at delivery: the rider cannot confirm without this proof.">
            <Select
              value={form.podPolicy}
              onChange={(e) =>
                set("podPolicy", e.target.value as "signature" | "otp" | "photo")
              }
            >
              <option value="signature">Signature</option>
              <option value="otp">OTP</option>
              <option value="photo">Photo</option>
            </Select>
          </Field>
        </div>
        {problem ? <ErrorNote>{problem}</ErrorNote> : null}
      </div>
    </Dialog>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
