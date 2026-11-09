const ONE_HOUR_MS = 60 * 60 * 1000;

/** A trip is overdue only while departed and more than one full hour past its ETA. */
export function isTripOverdue(
  status: string,
  expectedArrivalAt: Date | string | null | undefined,
  now = Date.now(),
  arrivedAt?: Date | string | null,
): boolean {
  if (status !== "departed" || expectedArrivalAt == null || arrivedAt != null) return false;

  const expectedArrivalTime = new Date(expectedArrivalAt).getTime();
  return Number.isFinite(expectedArrivalTime) && now - expectedArrivalTime > ONE_HOUR_MS;
}
