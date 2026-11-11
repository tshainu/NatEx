export type CounterHistoryDatePreset = "all" | "today" | "yesterday" | "this_week" | "this_month" | "this_year" | "custom";

export interface CounterHistoryDateRange {
  startDate?: string;
  endDate?: string;
}

function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Preset ranges use YYYY-MM-DD calendar dates supplied in Asia/Colombo. */
export function counterHistoryDateRange(
  preset: CounterHistoryDatePreset,
  today: string,
): CounterHistoryDateRange {
  switch (preset) {
    case "today":
      return { startDate: today, endDate: today };
    case "yesterday": {
      const yesterday = shiftCalendarDate(today, -1);
      return { startDate: yesterday, endDate: yesterday };
    }
    case "this_week": {
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const mondayOffset = (weekday + 6) % 7;
      return { startDate: shiftCalendarDate(today, -mondayOffset), endDate: today };
    }
    case "this_month":
      return { startDate: `${today.slice(0, 7)}-01`, endDate: today };
    case "this_year":
      return { startDate: `${today.slice(0, 4)}-01-01`, endDate: today };
    case "all":
    case "custom":
      return {};
  }
}
