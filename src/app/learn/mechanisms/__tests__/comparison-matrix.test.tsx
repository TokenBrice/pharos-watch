import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { MECHANISM_ARCHETYPE_LABELS } from "@shared/lib/classification";

import { MechanismComparisonMatrix } from "@/app/learn/mechanisms/comparison-matrix";

describe("MechanismComparisonMatrix", () => {
  const html = renderToStaticMarkup(<MechanismComparisonMatrix />);

  it("renders a row for every archetype label", () => {
    expect(html).toContain('data-table-id="mechanism-comparison-matrix"');
    expect(html).toContain('data-testid="mechanism-comparison-matrix-table"');
    expect(html).toContain('data-slot="table"');

    for (const archetype of MECHANISM_ARCHETYPE_VALUES) {
      expect(html).toContain(MECHANISM_ARCHETYPE_LABELS[archetype]);
    }
  });

  it("includes the canonical column headers", () => {
    expect(html).toContain("Collateral location");
    expect(html).toContain("Redemption right");
    expect(html).toContain("Yield source");
    expect(html).toContain("Primary failure mode");
    expect(html).toContain("Governance dep.");
    expect(html).toContain("Oracle dep.");
    expect(html).toContain("Jurisdiction dep.");
  });

  it("renders the archetype-specific verdicts", () => {
    // fiat-cash row
    expect(html).toContain("Banking-rail freeze");
    // tbill row
    expect(html).toContain("Redemption gate");
    // cdp row
    expect(html).toContain("Liquidation cascade");
    // synthetic
    expect(html).toContain("Carry / unwind stress");
    // algorithmic
    expect(html).toContain("Reflexive collapse");
    // rwa-credit-fund
    expect(html).toContain("NAV markdown");
  });
});
