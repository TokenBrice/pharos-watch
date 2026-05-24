import { describe, expect, it, vi } from "vitest";
import { getResolvedBlacklistStatus, getResolvedBlacklistStatusLabel } from "@/lib/blacklist-status";

vi.mock("@shared/lib/tracked-blacklist-status", () => ({
  getTrackedBlacklistStatus: (id: string) => (id === "usdp-parallel" ? "inherited" : null),
}));

vi.mock("@shared/lib/report-cards", () => ({
  getBlacklistStatusLabel: (status: boolean | "possible" | "inherited") => {
    if (status === true) return "Yes";
    if (status === "possible") return "Possible";
    if (status === "inherited") return "Upstream";
    return "No";
  },
}));

describe("blacklist status helpers", () => {
  it("uses the fixed-point tracked fallback for inherited coins", () => {
    expect(getResolvedBlacklistStatus("usdp-parallel")).toBe("inherited");
    expect(getResolvedBlacklistStatusLabel("usdp-parallel")).toBe("Upstream");
  });

  it("prefers report-card status when present", () => {
    expect(
      getResolvedBlacklistStatus("usdp-parallel", {
        rawInputs: { canBeBlacklisted: "possible" },
      } as never),
    ).toBe("possible");
  });
});
