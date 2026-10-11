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

  test("chargeable-weight setting is bounded by tariff coverage and accepts 0.5 kg steps", () => {
    const key = SETTING_KEYS.MAX_CHARGEABLE_WEIGHT_GRAMS;
    expect(SETTING_SPECS.find((spec) => spec.key === key)?.value).toBe(30_000);
    expect(settingProblem(key, 500)).toBeNull();
    expect(settingProblem(key, 20_000)).toBeNull();
    expect(settingProblem(key, 30_000)).toBeNull();
    expect(settingProblem(key, 0)).toContain("between 500 and 30000 grams");
    expect(settingProblem(key, 30_500)).toContain("between 500 and 30000 grams");
    expect(settingProblem(key, 20_250)).toContain("0.5 kg steps");
  });
});
