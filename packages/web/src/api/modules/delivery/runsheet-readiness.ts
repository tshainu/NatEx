export const RUNSHEET_ELIGIBLE_STATUSES = ["AtDestHub", "DeliveryAttempted", "OnHold"] as const;

export interface RunsheetReadinessInput {
  parcelStatus: string;
  parcelBranchId: string;
  runsheetBranchId: string;
  localDelivery?: boolean;
  reattemptAllowed?: boolean;
  reattemptReason?: string;
}

export interface RunsheetReadinessResult {
  ready: boolean;
  reason?: string;
  correction?: string;
}

const STATUS_LABEL: Record<string, string> = {
  Booked: "Booked",
  PickedUp: "Picked up",
  AtOriginHub: "At origin hub",
  Bagged: "Bagged for transport",
  InTransit: "In transit",
  AtDestHub: "At destination hub",
  OutForDelivery: "Already out for delivery",
  DeliveryAttempted: "Delivery attempted",
  OnHold: "On hold",
  Delivered: "Already delivered",
  RTOInitiated: "Returning to sender",
  RTOInTransit: "Returning to sender",
  RTODelivered: "Returned to sender",
  Lost: "Lost",
  Damaged: "Damaged",
  Cancelled: "Cancelled",
  ReturnedToMerchant: "Returned to merchant",
};

export function runsheetReadiness(input: RunsheetReadinessInput): RunsheetReadinessResult {
  if (input.parcelBranchId !== input.runsheetBranchId) {
    return {
      ready: false,
      reason: "This parcel belongs to a different accountable branch than the selected rider's runsheet.",
      correction: "Choose a runsheet for the parcel's accountable branch. If the branch assignment is wrong, complete an authorized branch transfer first.",
    };
  }

  const eligible = (RUNSHEET_ELIGIBLE_STATUSES as readonly string[]).includes(input.parcelStatus)
    || (input.localDelivery && input.parcelStatus === "AtOriginHub");
  if (!eligible) {
    const status = STATUS_LABEL[input.parcelStatus] ?? input.parcelStatus;
    const correction = input.parcelStatus === "OutForDelivery"
      ? "Check whether the parcel is already on another active runsheet; resolve that assignment before adding it again."
      : ["Delivered", "RTODelivered", "Lost", "Damaged", "Cancelled", "ReturnedToMerchant"].includes(input.parcelStatus)
        ? "Do not put this parcel on a delivery run. Ask Operations to resolve its current outcome if it is incorrect."
        : input.localDelivery
          ? "For a local delivery run, use a parcel at the selected hub with a destination address in the same district."
          : "Complete the required pickup/transport steps and record receipt at the destination hub before adding this parcel to a delivery run.";
    return {
      ready: false,
      reason: `Parcel status is ${status}; it is not ready for a delivery runsheet.`,
      correction,
    };
  }

  if (input.reattemptAllowed === false) {
    return {
      ready: false,
      reason: input.reattemptReason || "This parcel is not cleared for another delivery attempt.",
      correction: "Resolve the failed-delivery/retry hold in Operations first, then add the parcel again.",
    };
  }

  return { ready: true };
}
