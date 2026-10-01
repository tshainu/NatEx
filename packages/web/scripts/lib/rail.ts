import type { AppRouterClient } from "../../src/api";

/**
 * Stage booked parcels to AtDestHub at Kandy along the REAL M2 custody chain.
 *
 * Until 2026-10-01 the fixture scripts walked Bagged → InTransit with the
 * generic `parcels.transitionMany`. That only worked because the choke point
 * did not enforce §6 "Bagged → InTransit requires the bag to be sealed and
 * assigned to a trip" — it now does, so staging goes the way a parcel really
 * travels: Colombo hub → sealed bag → linehaul trip → Kandy hub receipt.
 *
 * Parcels must be booked at Colombo (`CMB_BRANCH`); they arrive as Kandy's
 * accountability, AtDestHub, exactly as `scripts/smoke.ts` proves.
 */
export const CMB_BRANCH = "brn_cmb_central";
export const KDY_HUB = "brn_kdy_hub";
const CMB_TRANSPORT_PHONE = "+94776789012";
const KDY_TRANSPORT_PHONE = "+94777890123";

type ClientFor = (token?: string, idemKey?: string) => AppRouterClient;
type Login = (phone: string) => Promise<{ accessToken: string; user: { name: string } }>;

export async function railToKandyHub(opts: {
  clientFor: ClientFor;
  login: Login;
  adminToken: string;
  awbs: string[];
  key: (label: string) => string;
  label: string;
}): Promise<void> {
  const { clientFor, adminToken, awbs, key, label } = opts;
  if (awbs.length === 0) return;

  for (const to of ["PickedUp", "AtOriginHub"] as const) {
    const res = await clientFor(adminToken, key(`rail-${label}-${to}`)).parcels.transitionMany({
      awbs,
      to,
      notes: "fixture staging",
    });
    if (res.rejected.length) throw new Error(`staging ${label} → ${to}: ${JSON.stringify(res.rejected)}`);
  }

  const cmb = await opts.login(CMB_TRANSPORT_PHONE);
  const kdy = await opts.login(KDY_TRANSPORT_PHONE);
  const stamp = `${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`;

  const bag = await clientFor(cmb.accessToken, key(`rail-${label}-bag`)).transport.bagCreate({
    destHubId: KDY_HUB,
  });
  const scan = await clientFor(cmb.accessToken, key(`rail-${label}-scan`)).transport.bagScan({
    bagId: bag.id,
    awbs,
  });
  if (scan.accepted.length !== awbs.length) {
    throw new Error(`staging ${label}: bag scan accepted ${scan.accepted.length}/${awbs.length} ${JSON.stringify(scan.rejected)}`);
  }
  const sealNumber = `FX-${stamp}`;
  await clientFor(cmb.accessToken, key(`rail-${label}-seal`)).transport.bagSeal({ bagId: bag.id, sealNumber });
  const trip = await clientFor(cmb.accessToken, key(`rail-${label}-trip`)).transport.tripCreate({
    vehicleRegistration: "FX-0001",
    destHubId: KDY_HUB,
    route: `Colombo → Kandy (fixture ${label})`,
  });
  await clientFor(cmb.accessToken, key(`rail-${label}-load`)).transport.tripLoad({ tripId: trip.id, bagId: bag.id });
  const departed = await clientFor(cmb.accessToken, key(`rail-${label}-depart`)).transport.tripDepart({
    tripId: trip.id,
    seal: `VEH-${stamp}`,
  });
  if (departed.rejected.length) throw new Error(`staging ${label}: depart rejected ${JSON.stringify(departed.rejected)}`);
  await clientFor(cmb.accessToken, key(`rail-${label}-arrive`)).transport.tripArrive({ tripId: trip.id });
  const receipt = await clientFor(kdy.accessToken, key(`rail-${label}-recv`)).transport.bagReceive({
    bagId: bag.id,
    scannedAwbs: awbs,
    sealNumber,
    releasedByName: "Fixture Driver",
    receivedByName: kdy.user.name,
  });
  if (receipt.received.length !== awbs.length || receipt.exceptionsRaised > 0) {
    throw new Error(
      `staging ${label}: receipt ${receipt.received.length}/${awbs.length}, ${receipt.exceptionsRaised} exception(s)`,
    );
  }
}
