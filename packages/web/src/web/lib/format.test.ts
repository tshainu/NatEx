import { describe, expect, test } from "bun:test";
import { humanise } from "./format";

describe("humanise", () => {
  test("splits camel case, acronyms and snake case", () => {
    expect(humanise("OutForDelivery")).toBe("Out For Delivery");
    expect(humanise("RTOInitiated")).toBe("RTO Initiated");
    expect(humanise("RTOInTransit")).toBe("RTO In Transit");
    expect(humanise("ops_decision")).toBe("ops decision");
    expect(humanise("Booked")).toBe("Booked");
  });
});
