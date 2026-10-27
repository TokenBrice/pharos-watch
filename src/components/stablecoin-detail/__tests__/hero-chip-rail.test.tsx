// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { HeroChipRail } from "../hero-card-sections";

vi.mock("@/lib/feature-flags", () => ({ isHeroVerdictEnabled: () => true }));
vi.mock("next/link", async () => {
  // Vitest hoists this mock factory; load the helper inside that isolated module boundary.
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

describe("detail verdict lane", () => {
  it("renders the verdict lane only when a verdict is shown, leaving the taxonomy unchanged", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { container, rerender } = render(<HeroChipRail coin={coin} verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />);
    expect(container.querySelector("[data-hero-verdict-lane]")).toBeNull();
    const initialTaxonomy = container.firstElementChild!.firstElementChild!.innerHTML;
    rerender(<HeroChipRail coin={coin} verdict={{ archetype: "yield-bearing-hybrid", label: "Yield-Bearing Hybrid" }} />);
    const lane = container.querySelector("[data-hero-verdict-lane]")!;
    expect(lane.textContent).toContain("Yield-Bearing Hybrid");
    const taxonomy = lane.nextElementSibling!;
    expect(taxonomy.innerHTML).toBe(initialTaxonomy);
    expect(taxonomy.textContent).not.toContain("Yield-Bearing Hybrid");
  });

  it("renders no lane and no chip for the internal institutional-default archetype", () => {
    const coin = TRACKED_META_BY_ID.get("usdc-circle")!;
    const { container } = render(<HeroChipRail coin={coin} verdict={{ archetype: "institutional-default", label: "Institutional Default" }} />);
    expect(container.querySelector("[data-hero-verdict-lane]")).toBeNull();
    expect(container.querySelector(`#hero-verdict-${coin.id}`)).toBeNull();
    expect(container.textContent).not.toContain("Institutional");
  });
});
