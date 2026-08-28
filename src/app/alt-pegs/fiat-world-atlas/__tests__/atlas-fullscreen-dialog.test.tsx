// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AtlasFullscreenDialog } from "@/app/alt-pegs/fiat-world-atlas/atlas-fullscreen-dialog";

vi.mock("@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live", () => ({
  PegDiversityHeroLive: ({ variant }: { variant?: string }) => (
    <div data-testid="hero-live" data-variant={variant ?? "default"} />
  ),
}));

vi.mock("@/app/alt-pegs/fiat-world-atlas/world-map", () => ({
  WorldMap: () => <div data-testid="world-map" />,
}));

describe("AtlasFullscreenDialog", () => {

  it("renders nothing when closed", () => {
    render(<AtlasFullscreenDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("hero-live")).toBeNull();
  });

  it("renders a labeled dialog with the atlas body in fullscreen variant when open", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /peg diversity atlas/i });
    expect(dialog).toBeTruthy();
    const hero = screen.getByTestId("hero-live");
    expect(hero.getAttribute("data-variant")).toBe("fullscreen");
  });

  it("does not inherit the shared desktop modal width cap", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    const dialog = screen.getByRole("dialog", { name: /peg diversity atlas/i });
    expect(dialog.className).toContain("sm:max-w-none");
  });

  it("exposes a Close atlas control as the first focusable element", () => {
    render(<AtlasFullscreenDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByRole("button", { name: /close atlas/i })).toBeTruthy();
  });

  it("calls onOpenChange(false) when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    render(<AtlasFullscreenDialog open={true} onOpenChange={onOpenChange} />);
    const close = screen.getByRole("button", { name: /close atlas/i });
    close.click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
