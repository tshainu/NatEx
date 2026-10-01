import { useQuery } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { coords, date, humanise } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Page, Card, KeyValue, KeyValueGrid, ErrorNote } from "@/components/natex/page";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/components/auth-provider";

/**
 * Merchant account. A merchant user is scoped to its own merchant record by the
 * server (§5 row-level scoping) — merchants.list returns exactly one row for
 * this caller, so there is no id to pass and nothing to pick.
 */

export default function MerchantAccount() {
  const user = useAuth().session!.user;
  const merchants = useQuery(
    orpc.merchants.list.queryOptions({ input: { page: 1, pageSize: 5 } }),
  );
  const merchant = merchants.data?.rows[0];
  const error = merchants.error
    ? apiMessage(merchants.error, "Your account could not be loaded.")
    : null;

  return (
    <Page
      title="Account"
      description="What NatEx holds on file for you."
      actions={
        merchant ? (
          <Badge variant={merchant.status === "active" ? "good" : "warn"}>
            {merchant.status === "active" ? "Active" : "Suspended"}
          </Badge>
        ) : null
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card title="Account details">
        {merchants.isLoading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/4" />
          </div>
        ) : merchant ? (
          <KeyValueGrid columns={3}>
            <KeyValue label="Merchant name">{merchant.name}</KeyValue>
            <KeyValue label="VAT number" mono>
              {merchant.vatNo || "—"}
            </KeyValue>
            <KeyValue label="On file since" mono>
              {date(merchant.createdAt)}
            </KeyValue>
            <KeyValue label="Contact">{merchant.contactName}</KeyValue>
            <KeyValue label="Contact phone" mono>
              {merchant.contactPhone}
            </KeyValue>
            <KeyValue label="Signed-in user">{user.name}</KeyValue>
            <KeyValue label="Pickup address" className="col-span-2">
              {merchant.address}
            </KeyValue>
            <KeyValue label="Geocode" mono>
              {coords(merchant.lat, merchant.lng)}
            </KeyValue>
            <KeyValue label="Cash on delivery">
              <Badge variant={merchant.codEnabled ? "good" : "muted"}>
                {merchant.codEnabled ? "Enabled" : "Prepaid only"}
              </Badge>
            </KeyValue>
            <KeyValue label="Proof of delivery">{humanise(merchant.podPolicy)}</KeyValue>
            <KeyValue label="Rate card" mono>
              {merchant.rateCardId ?? "Not assigned"}
            </KeyValue>
          </KeyValueGrid>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            This login is not linked to a merchant record. Ask NatEx operations to attach your
            user to a merchant account.
          </p>
        )}
      </Card>

      <Card title="How your account works" className="max-w-3xl">
        <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Booking.</span> Book one parcel at a
            time or upload a CSV under Book parcels. Every parcel is
            picked up from the pickup address above.
          </p>
          <p>
            <span className="font-medium text-foreground">Pickups.</span> Name the booked parcels
            and a date; NatEx operations assigns a rider and the request shows as scheduled.
          </p>
          <p>
            <span className="font-medium text-foreground">Account changes.</span> Your address,
            COD eligibility and proof-of-delivery policy are held by NatEx operations — ask
            your account contact to change them.
          </p>
        </div>
      </Card>
    </Page>
  );
}
