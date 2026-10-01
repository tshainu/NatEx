import { useAuth } from "@/components/auth-provider";
import { Page } from "@/components/natex/page";
import { NdrQueue, RtoQueue } from "@/components/natex/ndr-panels";
import { TabStrip, useTabParam } from "@/components/natex/tab-strip";
import { useNdrCounts, useRtoCounts } from "@/queries/ndr";

/**
 * /merchant/ndr — the merchant's half of the NDR loop (§8, §10 M3).
 *
 * The same queue components ops uses, in `merchantView`: the server scopes
 * every read to this merchant (§5), and the only action offered is the
 * merchant's instruction — reattempt, change address, or return to origin.
 * Closing an NDR without an answer and dispatching a return stay with ops.
 */

const TABS = ["ndr", "rto"] as const;

export default function MerchantNdr() {
  const role = useAuth().session!.user.role;
  const [tab, setTab] = useTabParam("tab", TABS, "ndr");
  const ndr = useNdrCounts();
  const rto = useRtoCounts();

  return (
    <Page
      title="NDR & returns"
      description="Deliveries that failed and need your instruction, oldest first against the answer deadline. Returns heading back to you are on the second tab."
    >
      <TabStrip
        label="NDR and returns"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: "ndr",
            label: "Need your answer",
            badge: ndr.data ? ndr.data.open + ndr.data.instructed + ndr.data.reattemptScheduled : undefined,
          },
          {
            id: "rto",
            label: "Returns to you",
            badge: rto.data ? rto.data.initiated + rto.data.inTransit : undefined,
          },
        ]}
      />
      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "ndr" ? <NdrQueue role={role} merchantView /> : <RtoQueue role={role} merchantView />}
      </div>
    </Page>
  );
}
