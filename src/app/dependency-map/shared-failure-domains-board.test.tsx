// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SharedFailureDomainsBoard } from "./shared-failure-domains-board";
import type { SharedFailureDomainGroups } from "@/lib/shared-failure-domains-model";
import type { SupplyOf } from "@shared/lib/dependency-exposure";

const supplyOf: SupplyOf = id => ({ usd: id === "a" ? 100 : 50, asOf: 1790726400, basis: id === "a" ? "publication-circulating" : "market-cap-proxy" });
const cards = [{ id: "a", name: "Alpha", symbol: "AAA" }, { id: "b", name: "Beta", symbol: "BBB" }];
const groups: SharedFailureDomainGroups = [{ id: "mint-control:operator", kind: "mint-control", key: "operator", memberAssetIds: ["a", "b"], pricedEffectsIncomplete: true, pricedEffects: [{ assetId: "a", capIndices: [0], deploymentAdjustmentIndices: [0], resolvedCaps: [{ kind: "mint-integrity", limit: 55 }], resolvedAdjustments: [{ scoreBefore: 80, scoreAfter: 72, adjustmentPoints: 8 }] }] }];

afterEach(cleanup);

describe("SharedFailureDomainsBoard", () => {
  it("distinguishes unpublished domains from an empty published census", () => {
    const { rerender } = render(<SharedFailureDomainsBoard groups={null} cards={cards} supplyOf={supplyOf} />);
    expect(screen.getByText(/were not published for this generation/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    rerender(<SharedFailureDomainsBoard groups={[]} cards={cards} supplyOf={supplyOf} />);
    expect(screen.getByText(/published census contains no groups/)).toBeTruthy();
    expect(screen.queryByText(/were not published/)).toBeNull();
  });
  it("shows member links, supply provenance, published cap prices and the incomplete warning", () => {
    render(<SharedFailureDomainsBoard groups={groups} cards={cards} supplyOf={supplyOf} />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Mint control")).toBeTruthy();
    expect(within(table).getByText("$150.00")).toBeTruthy();
    expect(within(table).getByText(/1 publication-bound supplies; 1 market caps/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "BBB" }).getAttribute("href")).toBe("/stablecoin/b");
    expect(within(table).getByText("mint-integrity cap: 55")).toBeTruthy();
    expect(within(table).getByText("Deployment adjustment: 80 → 72 (8 points)")).toBeTruthy();
    expect(within(table).getByText(/Priced effects incomplete: an evaluated structural signal/)).toBeTruthy();
  });
  it("discloses unavailable references without implying a zero effect or using prohibited copy", () => {
    const unresolved = [{ ...groups[0], pricedEffects: [{ assetId: "a", capIndices: [0], deploymentAdjustmentIndices: [] }] }];
    const { container } = render(<SharedFailureDomainsBoard groups={unresolved} cards={cards} supplyOf={supplyOf} />);
    expect(screen.getByText(/Some referenced cap or deployment adjustment values are unavailable/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/likely impact|at risk|expected loss|coins fail|\bsafe\b|\bshock\b|\bscenario\b/i);
    expect(screen.getByText("Shared control or custody identity across tracked coins; not an additive loss estimate")).toBeTruthy();
  });
});
