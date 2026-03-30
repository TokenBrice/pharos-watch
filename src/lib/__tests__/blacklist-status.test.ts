import { describe, expect, it } from "vitest";
import { getResolvedBlacklistStatus, getResolvedBlacklistStatusLabel } from "@/lib/blacklist-status";

describe("blacklist status helpers", () => {
  it("uses the fixed-point tracked fallback for inherited coins", () => {
    expect(getResolvedBlacklistStatus("usdp-parallel")).toBe("inherited");
    expect(getResolvedBlacklistStatusLabel("usdp-parallel")).toBe("Upstream");
  });

  it("prefers report-card status when present", () => {
    expect(getResolvedBlacklistStatus("usdp-parallel", {
      rawInputs: { canBeBlacklisted: "possible" },
    } as never)).toBe("possible");
  });
});
