// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

const mockRedemptionConfigs = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("@shared/lib/redemption-backstop-configs", () => ({
  REDEMPTION_BACKSTOP_CONFIGS: mockRedemptionConfigs,
}));

const { buildPhysicalDeliveryRows, PhysicalDeliveryTermsTable } = await import("../physical-delivery-terms-table");

const delivery = (commodity: "XAU" | "XAG", minimumDeliveryTokens: number) => ({
  commodity, deliverableOuncesPerToken: 1, minimumDeliveryTokens, deliveryTermsUnbounded: true,
  feeModel: { bps: 0, flatUsd: 0, deliveryUsd: 0 }, sameNotionalEligible: false,
});

const goldRoute = {
  reviewedAt: "2026-09-21",
  physicalCommodityDelivery: delivery("XAU", 430),
  physicalToUsd: {
    metal: "XAU",
    fineTroyOuncesPerToken: 1,
    lot: { minimumTokens: 430, incrementTokens: null, bars: [] },
    vaultLocations: ["london", "zurich"],
    barClass: "good-delivery",
    eligibility: "verified-customer",
    reviewedAt: "2026-10-01",
    reviewExpiresAt: "2026-12-30",
  },
};

const coins = [
  { id: "gold-a", name: "Gold A", symbol: "GLDA" },
  { id: "gold-b", name: "Gold B", symbol: "GLDB" },
  { id: "silver-a", name: "Silver A", symbol: "SLVA" },
  { id: "gold-none", name: "Gold None", symbol: "GLDN" },
];

describe("PhysicalDeliveryTermsTable", () => {
  afterEach(() => {
    for (const key of Object.keys(mockRedemptionConfigs)) delete mockRedemptionConfigs[key];
    vi.useRealTimers();
  });

  it("builds metal-matched rows from reviewed delivery terms and marks unreviewed cells", () => {
    Object.assign(mockRedemptionConfigs, {
      "gold-a": goldRoute,
      "gold-b": { reviewedAt: "2026-10-20", physicalCommodityDelivery: delivery("XAU", 1000) },
      "silver-a": { reviewedAt: "2026-09-21", physicalCommodityDelivery: delivery("XAG", 2100) },
    });
    const rows = buildPhysicalDeliveryRows("GOLD", coins, "2026-10-25");

    expect(rows.map((row) => row.id)).toEqual(["gold-a", "gold-b"]);
    expect(rows[0]!.cells).toMatchObject({
      metal: "1 troy oz",
      minimum: "430 GLDA",
      bar: "London Good Delivery bar",
      vaults: "London, Zurich",
      eligibility: "Verified customers",
      reviewed: "Oct 1, 2026",
    });
    expect(rows[1]!.cells).toMatchObject({ minimum: "1,000 GLDB", bar: "Not recorded", reviewed: "Oct 20, 2026" });
    expect(buildPhysicalDeliveryRows("SILVER", coins, "2026-10-25").map((row) => row.id)).toEqual(["silver-a"]);
    expect(buildPhysicalDeliveryRows("USD", coins, "2026-10-25")).toEqual([]);
  });

  it("omits routes whose physical or redemption review has expired", () => {
    Object.assign(mockRedemptionConfigs, { "gold-a": goldRoute });
    expect(buildPhysicalDeliveryRows("GOLD", coins, "2026-12-31")).toEqual([]);
    Object.assign(mockRedemptionConfigs, {
      "gold-a": { reviewedAt: "2025-01-01", physicalCommodityDelivery: delivery("XAU", 430) },
    });
    expect(buildPhysicalDeliveryRows("GOLD", coins, "2026-10-25")).toEqual([]);
  });

  it("renders a linked table, or nothing when no row qualifies", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T00:00:00Z"));
    const { container, rerender } = render(<PhysicalDeliveryTermsTable pegCurrency="GOLD" coins={coins} />);
    expect(container.innerHTML).toBe("");

    Object.assign(mockRedemptionConfigs, { "gold-a": goldRoute });
    rerender(<PhysicalDeliveryTermsTable pegCurrency="GOLD" coins={coins} />);
    expect(screen.getByRole("heading", { name: "Physical delivery terms" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gold A (GLDA)" }).getAttribute("href")).toBe("/stablecoin/gold-a/");
  });
});
