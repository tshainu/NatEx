import { useQuery } from "@tanstack/react-query";
import { orpc, apiMessage } from "@/lib/api";
import { date } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Page, Card, KeyValue, KeyValueGrid, ErrorNote } from "@/components/natex/page";
import { useAuth } from "@/components/auth-provider";

/**
 * Field staff landing. Riders and transport staff work in the mobile app —
 * scanning, handover signatures and geo-stamps need a camera and a GPS, and the
 * device binding that guards a rider session is issued to a phone, not a
 * browser. This page confirms who is signed in and sends them to the app.
 */
export default function FieldHome() {
  const user = useAuth().session!.user;
  const isRider = user.role === "rider";

  const today = useQuery({
    ...orpc.collection.riderToday.queryOptions({ input: {} }),
    enabled: isRider,
  });

  const manifests = today.data?.manifests ?? [];

  return (
    <Page
      title="Field staff"
      description="Collection runs happen on the handheld. This browser view is for checking your assignment only."
      actions={<Badge variant="brand">Use the NatEx mobile app</Badge>}
    >
      <Card title="Your session">
        <KeyValueGrid columns={3}>
          <KeyValue label="Name">{user.name}</KeyValue>
          <KeyValue label="Role">{isRider ? "Rider" : "Transport"}</KeyValue>
          <KeyValue label="Branch">{user.branchName || "—"}</KeyValue>
          <KeyValue label="Bound device" mono>
            {user.deviceId ?? "Not bound — sign in from the app"}
          </KeyValue>
        </KeyValueGrid>
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          A rider session is bound to one device id. Signing in on a second handset invalidates
          the first, which is how a lost phone stops being able to scan.
        </p>
      </Card>

      {isRider ? (
        <Card
          title="Today's pickup assignment"
          description="Read-only here. Scanning and handover are in the app."
          bodyClassName={manifests.length > 0 ? "p-0" : undefined}
        >
          {today.error ? (
            <ErrorNote>
              {apiMessage(today.error, "Your assignment could not be loaded.")}
            </ErrorNote>
          ) : today.isLoading ? (
            <p className="text-[13px] text-muted-foreground">Loading your run…</p>
          ) : manifests.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No pickup manifest is assigned to you for today. Operations assigns runs from the
              Pickup manifests screen.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {manifests.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{m.merchantName}</p>
                    <p className="truncate text-[12px] text-muted-foreground">
                      Pickup <span className="font-mono">{date(m.pickupDate)}</span> ·{" "}
                      <span className="font-mono">{m.scannedCount}</span>/
                      <span className="font-mono">{m.expectedCount}</span> scanned
                    </p>
                  </div>
                  <Badge variant={m.status === "handed_over" ? "good" : "brand"}>
                    {m.status === "handed_over"
                      ? "Handed over"
                      : m.status === "in_progress"
                        ? "In progress"
                        : "Assigned"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <Card title="Transport" className="max-w-2xl">
          <p className="text-[14px] font-semibold">Bagging and line-haul trips run in the mobile app.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
            Bag scanning and sealing, trip loading, departure with a vehicle seal and inbound
            receipt at the destination hub all need the handheld&apos;s scanner, so they live in the
            NatEx app&apos;s transport tabs. Sign in there with this phone number.
          </p>
        </Card>
      )}
    </Page>
  );
}
