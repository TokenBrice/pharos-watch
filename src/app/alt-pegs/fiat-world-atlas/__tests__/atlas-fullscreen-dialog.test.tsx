// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";

vi.mock("@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live", () => ({
  PegDiversityHeroLive: ({ variant }: { variant?: string }) => (
    <button data-testid="hero-live" data-variant={variant ?? "default"}>Inspect atlas coin</button>
  ),
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/world-map", () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

describe("AtlasFullscreenDialog", () => {

  it("focuses Close atlas when opened with interactive atlas content", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Inspect atlas coin" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /close atlas/i }));
  });

});
