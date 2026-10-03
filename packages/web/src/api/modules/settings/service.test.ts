import { describe, expect, test } from "bun:test";
import { SETTING_KEYS, SETTING_SPECS, settingProblem } from "./service";

describe("settings validation", () => {
  test("every spec's default is inside its own range", () => {
    for (const s of SETTING_SPECS) {
      expect(settingProblem(s.key, s.value)).toBeNull();
    }
  });
  test("ranges, integers and switches are enforced", () => {
    expect(settingProblem(SETTING_KEYS.NDR_SLA_HOURS, 0)).toContain("between 1 and 168");
    expect(settingProblem(SETTING_KEYS.NDR_SLA_HOURS, 1.5)).toBe("Must be a whole number.");
    expect(settingProblem(SETTING_KEYS.MFA_ENFORCED, 2)).toContain("0 (off) or 1 (on)");
    expect(settingProblem(SETTING_KEYS.SESSION_IDLE_MINUTES, 14)).not.toBeNull();
    // Idle floor is 30: below the 15-minute access token it would end sessions mid-use.
    expect(settingProblem(SETTING_KEYS.SESSION_IDLE_MINUTES, 29)).toContain("between 30 and 10080");
    expect(settingProblem(SETTING_KEYS.SESSION_IDLE_MINUTES, 30)).toBeNull();
    expect(settingProblem(SETTING_KEYS.SESSION_MAX_DAYS, 30)).toBeNull();
  });
});
