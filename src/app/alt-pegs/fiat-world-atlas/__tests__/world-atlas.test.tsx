// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FiatWorldAtlas } from "@/app/alt-pegs/fiat-world-atlas/world-atlas";

vi.mock("@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live", () => ({
  PegDiversityHeroLive: () => <div data-testid="hero-live" />,
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/world-map", () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

describe("FiatWorldAtlas", () => {
  afterEach(() => cleanup());

  it("uses Alt-Peg Atlas as the single visible title", () => {
    render(<FiatWorldAtlas fiatItems={[]} commodityIndexItems={[]} />);

    expect(screen.getByRole("heading", { name: "Peg Diversity Atlas" })).toBeTruthy();
    expect(screen.queryByText("Peg Diversity Map")).toBeNull();
  });

  it("renders an Expand atlas trigger button", () => {
    render(<FiatWorldAtlas fiatItems={[]} commodityIndexItems={[]} />);
    const trigger = screen.getByRole("button", { name: /expand atlas/i });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
