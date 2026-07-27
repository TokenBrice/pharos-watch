import { describe, expect, it, vi } from "vitest";
import { getResolvedBlacklistStatus, getResolvedBlacklistStatusLabel } from "@/lib/blacklist-status";

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_TRACKED_META_BY_ID: new Map([
    ["usdp-parallel", { blacklistStatus: "inherited" }],
  ]),
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
});
