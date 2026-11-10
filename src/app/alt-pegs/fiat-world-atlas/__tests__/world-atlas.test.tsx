// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FiatWorldAtlas } from "@/app/alt-pegs/fiat-world-atlas/world-atlas";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";

vi.mock("@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live", () => ({
  PegDiversityHeroLive: ({ variant }: { variant?: string }) => (
    <button data-testid="hero-live" data-variant={variant ?? "default"}>Inspect atlas coin</button>
  ),
  MAP_SIZE_CAP_LABEL: "~$220M",
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/world-map", () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

describe("FiatWorldAtlas", () => {

  it("renders an Expand atlas trigger button", () => {
    render(<FiatWorldAtlas />);
    const trigger = screen.getByRole("button", { name: /expand atlas/i });
    expect(trigger).toBeTruthy();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("focuses Close atlas when opened with interactive atlas content", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Inspect atlas coin" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close atlas/i }));
  });
});
