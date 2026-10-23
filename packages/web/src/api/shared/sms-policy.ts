const TRACKING_MATERIAL = /\{\{\s*(?:awb|tracking_?number|track_?url|tracking_?url)\s*\}\}|\bNX(?:\d{8,}|B-\d{8}-[A-Z0-9]{6,})\b|https?:\/\/|www\.|\/track\//i;

/** True when an SMS body contains a tracking number, tracking placeholder, or link. */
export function containsTrackingMaterial(body: string): boolean {
  return TRACKING_MATERIAL.test(body);
}

/** Defense-in-depth at the last SMS boundary, including raw outbox callers. */
export function assertPodSmsHasNoTrackingMaterial(body: string): void {
  if (containsTrackingMaterial(body)) {
    throw new Error("POD SMS must not include a tracking number or tracking link.");
  }
}
