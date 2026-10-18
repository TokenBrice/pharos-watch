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
  it("keeps the taxonomy in its own row when the late V9 verdict arrives", () => {
    const coin = TRACKED_META_BY_ID.get("usdt-tether")!;
    const { container, rerender } = render(<HeroChipRail coin={coin} verdict={{ archetype: "uncategorized", label: "Uncategorized" }} />);
    const lane = container.querySelector("[data-hero-verdict-lane]")!;
    expect(lane.className).toContain("min-h-5");
    expect(lane.textContent).toBe("");
    const taxonomy = lane.nextElementSibling!;
    const initialTaxonomy = taxonomy.innerHTML;
    rerender(<HeroChipRail coin={coin} verdict={{ archetype: "institutional-default", label: "Institutional Default" }} />);
    expect(container.querySelector("[data-hero-verdict-lane]")).toBe(lane);
    expect(lane.textContent).toContain("Institutional Default");
    expect(lane.nextElementSibling).toBe(taxonomy);
    expect(taxonomy.innerHTML).toBe(initialTaxonomy);
    expect(taxonomy.textContent).not.toContain("Institutional Default");
  });
});
