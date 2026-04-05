import { describe, it, expect } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";

describe("evidence class promotions", () => {
  it("usdd-data-platform has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["usdd-data-platform"].evidenceClass).toBe("independent");
  });

  it("re-metrics has independent evidence class", () => {
    expect(LIVE_RESERVE_ADAPTER_DEFINITIONS["re-metrics"].evidenceClass).toBe("independent");
  });
});
