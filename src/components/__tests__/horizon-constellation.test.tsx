// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HorizonConstellation } from "@/components/horizon-constellation";
import type { DriftDisplayStatus } from "@/lib/pre-launch";

const fixture = vi.hoisted(() => [
  ...Array.from({ length: 13 }, (_, index) => ({
    id: `coin-${index}`, name: `Coin ${index}`, symbol: `C${index}`,
    status: "pre-launch", launchPhase: "announced",
    expectedLaunchDate: `2027-01-${String(index + 1).padStart(2, "0")}`,
  })),
  { id: "unphased-0", name: "Unphased 0", symbol: "U0", status: "pre-launch" },
]);

vi.mock("@shared/lib/stablecoins/client-registry", () => ({ CLIENT_TRACKED_STABLECOINS: fixture }));
vi.mock("@/lib/logos", () => ({ logosById: {}, getLogoSrc: () => undefined }));

const DRIFT = new Map<string, DriftDisplayStatus>([
  ["coin-0", "pushed-once"],
  ["coin-10", "overdue"],
  ["coin-11", "pushed-multiple"],
  ["unphased-0", "on-track"],
  ["coin-12", "no-current-target"],
]);

function renderTracker() {
  return render(
    <HorizonConstellation
      widePhaseClassName=""
      narrowPhaseClassName=""
      slippage
      driftById={DRIFT}
      includeUnphased
    />,
  );
}

describe("HorizonConstellation slippage", () => {
  it("rings drawn slipped coins and tallies the folded ones, so rings + tallies equal Slipped", () => {
    renderTracker();
    // Wide and narrow both draw coin-0; each carries the pushed mark.
    expect(screen.getAllByRole("link", { name: "Coin 0 (C0) — Announced, target pushed" })).toHaveLength(2);
    // Wide: 8 dots drawn, coins 8–12 folded (coin-10 overdue, coin-11 pushed;
    // coin-12 has no current target, so it is neither ringed nor tallied).
    expect(screen.getByRole("link", { name: "5 more announced stablecoins (1 pushed, 1 overdue)" })).toBeTruthy();
    // Phone lane: 5 dots plus a tallied marker instead of silently clipping.
    expect(screen.getByRole("link", { name: "8 more announced stablecoins (1 pushed, 1 overdue)" })).toBeTruthy();
  });

  it("ships the final tracker layout before the clock is read, and links +N to the phase filter", () => {
    render(<HorizonConstellation widePhaseClassName="" narrowPhaseClassName="" slippage includeUnphased />);
    const wide = screen.getByRole("link", { name: "5 more announced stablecoins" });
    const phone = screen.getByRole("link", { name: "8 more announced stablecoins" });
    expect(wide.getAttribute("href")).toMatch(/^\/upcoming\/?\?phase=announced#data$/);
    expect(phone.getAttribute("href")).toMatch(/^\/upcoming\/?\?phase=announced#data$/);
  });

  it("adds the Unphased cell so cells sum to the full pre-launch count", () => {
    renderTracker();
    expect(screen.getByText("Phase not assigned: 1 coin")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Unphased 0 (U0) — Phase not assigned" })).toHaveLength(2);
  });

  it("keeps the homepage teaser unchanged without drift or the Unphased cell", () => {
    render(<HorizonConstellation widePhaseClassName="" narrowPhaseClassName="" />);
    expect(screen.queryByText(/Phase not assigned/)).toBeNull();
    expect(screen.getByRole("link", { name: "5 more announced stablecoins" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /8 more/ })).toBeNull();
    expect(screen.getByRole("link", { name: "5 more announced stablecoins" }).getAttribute("href")).toMatch(/^\/upcoming\/?$/);
  });
});
