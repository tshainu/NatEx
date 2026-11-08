const DELIVERY_PAYLOAD_KEYS = new Set([
  "awb",
  "receivedByName",
  "receivedByRelation",
  "receiverPhone",
  "receiverNicLast4",
  "otpChallengeId",
  "method",
  "signatureData",
  "photoUrl",
  "photoNote",
  "codCollectedCents",
  "freightCollectedCents",
  "freightPaymentMethod",
  "freightExternalReference",
  "notes",
  "lat",
  "lng",
  "clientId",
  "clientTs",
]);

/** Whitelist fields before hashing, journaling, conflict capture, or application. */
export function sanitizeDeliveryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => DELIVERY_PAYLOAD_KEYS.has(key)));
}

export interface DeliveryPushOperation {
  clientOpId: string;
  kind: string;
  payload: Record<string, unknown>;
  seq: number;
  clientTs?: number | null;
}

export function sanitizeDeliveryOperation<T extends DeliveryPushOperation>(op: T): T {
  if (op.kind !== "delivery.deliver") return op;
  return { ...op, payload: sanitizeDeliveryPayload(op.payload) };
}
