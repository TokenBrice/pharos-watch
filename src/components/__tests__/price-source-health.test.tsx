// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PriceSourceHealthSchema } from "@shared/types/pricing-source-health";
import { PriceSourceHealthCard } from "@/components/status/price-source-health";

const legacy = { totalAssets: 567, lastSync: 100,
  confidenceDistribution: { high: 115, "single-source": 325, low: 20, fallback: 1 },
  sourceDistribution: { missing: 106 } };
afterEach(cleanup);
describe("price source health scope", () => {
  it("labels old payloads as cache-wide instead of claiming active scope", () => {
    render(<PriceSourceHealthCard health={PriceSourceHealthSchema.parse(legacy)} nowSeconds={100} />);
    expect(screen.getByText(/567 cached assets/)).toBeTruthy();
    expect(screen.getByText("106")).toBeTruthy();
  });
  it("shows active missing prices while retaining all-cache counts", () => {
    const health = PriceSourceHealthSchema.parse({ ...legacy, active: { totalAssets: 334,
      confidenceDistribution: { high: 111, "single-source": 186, low: 20, fallback: 1 },
      sourceDistribution: { missing: 16 } } });
    render(<PriceSourceHealthCard health={health} nowSeconds={100} />);
    expect(screen.getByText(/334 active assets/)).toBeTruthy();
    expect(screen.getByText("16")).toBeTruthy();
    expect(screen.getByText("4.8%")).toBeTruthy();
    expect(screen.getByText(/Full cache: 567 rows · 106 missing/)).toBeTruthy();
  });
});
