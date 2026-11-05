const MINUTES_PER_DAY = 24 * 60;

function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Normalize a manual or Excel time cell to 24-hour HH:MM. Excel time cells may
 * arrive as a Date or as a fractional day; empty cells stay null. The value is
 * kept as a Colombo-local wall time and is not used to derive paid hours.
 */
export function parseTimesheetTimeCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Use a valid 24-hour time in HH:MM format.");
    return formatMinutes(value.getUTCHours() * 60 + value.getUTCMinutes());
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("Use an Excel time-of-day value between 00:00 and 23:59.");
    const totalMinutes = Math.floor(value * MINUTES_PER_DAY + Number.EPSILON);
    if (totalMinutes < 0 || totalMinutes >= MINUTES_PER_DAY) throw new Error("Use an Excel time-of-day value between 00:00 and 23:59.");
    return formatMinutes(totalMinutes);
  }

  const text = String(value).trim();
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) throw new Error("Use a valid 24-hour time in HH:MM format.");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error("Use a valid 24-hour time in HH:MM format.");
  return formatMinutes(hours * 60 + minutes);
}
