// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YieldAccessStructure } from "@/components/yield-access-structure";
import { YieldChangeAttributionCard } from "@/components/yield-change-attribution-card";
import { YieldSourceRiskBar } from "@/components/yield-source-risk-bar";
import { YieldWatchlistStar } from "@/components/yield-watchlist-star";
import { YieldApiWarnings } from "@/components/yield/yield-data-health";

describe("YieldApiWarnings", () => {
  afterEach(cleanup);

  it("keeps safety-hydration fallbacks operator-only and shows other API warnings", () => {
    const { container, rerender } = render(<YieldApiWarnings warnings={[
      { code: "yield-safety-hydration-stale", message: "Serving the last coherent published safety snapshot." },
      { code: "yield-safety-hydration-degraded", message: "Live safety hydration is degraded.", reasons: ["v9-held"] },
    ]} />);
    expect(container.textContent).toBe("");

    rerender(<YieldApiWarnings warnings={[{ code: "yield-new-advisory", message: "Rankings advisory." }]} />);
    expect(screen.getByLabelText("Yield API warnings").textContent).toContain("Rankings advisory.");
  });
});

describe("YieldAccessStructure", () => {
  afterEach(cleanup);

  it.each([
    [undefined, "Unknown"],
    [null, "Unknown"],
    [0, "0 min"],
    [1, "<1 min"],
    [29, "<1 min"],
    [59, "<1 min"],
    [60, "1 min"],
    [3_599, "60 min"],
    [3_600, "1 hr"],
    [5_400, "1.5 hr"],
    [86_400, "1 days"],
    [129_600, "1.5 days"],
  ] as const)("displays withdrawal delay %s as %s", (withdrawalDelaySeconds, expected) => {
    render(<YieldAccessStructure sourceRisk={{ withdrawalDelaySeconds }} />);
    expect(screen.getByText("Withdrawal delay").nextElementSibling?.textContent).toBe(expected);
  });
});

describe("YieldChangeAttributionCard", () => {
  it("does not label a source-switch delta as a 30d APY impact", () => {
    const { container } = render(
      <YieldChangeAttributionCard
        attribution={{
          attribution: "source-switch",
          confidence: "medium",
          headline: "Source switched from Aave (+1.2pp impact).",
          largestDelta: { value: 1.2, ts: Date.UTC(2026, 9, 1) },
          sourceSwitchDetail: { previousSourceKey: "aave", previousSourceLabel: "Aave", apy30dDelta: 1.2 },
        }}
      />,
    );

    expect(container.textContent).toContain("impact on APY.");
    expect(container.textContent).not.toContain("impact on 30d APY");
  });
});

describe("YieldSourceRiskBar", () => {
  it("renders unavailable state for null score", () => {
    render(<YieldSourceRiskBar score={null} />);
    expect(screen.getByLabelText("Source-risk score unavailable")).toBeTruthy();
  });

  it("renders aria label for score 0", () => {
    render(<YieldSourceRiskBar score={0} />);
    expect(screen.getByLabelText("Source-risk score: 0 of 100")).toBeTruthy();
  });

  it("renders aria label for score 100", () => {
    render(<YieldSourceRiskBar score={100} />);
    expect(screen.getByLabelText("Source-risk score: 100 of 100")).toBeTruthy();
  });
});

describe("YieldWatchlistStar", () => {
  const STORAGE_KEY = "pharos-watchlist-v1";
  const gtag = vi.fn();

  beforeEach(() => {
    window.localStorage.clear();
    window.gtag = gtag;
  });

  afterEach(() => {
    gtag.mockReset();
    delete window.gtag;
  });

  it("toggles to aria-pressed true after click and persists to storage", async () => {
    render(<YieldWatchlistStar stablecoinId="usdc-circle" symbol="USDC" />);
    const button = await screen.findByRole("button", { name: "Add USDC to watchlist" });

    fireEvent.click(button);

    const toggled = await screen.findByRole("button", { name: "Remove USDC from watchlist" });
    expect(toggled.getAttribute("aria-pressed")).toBe("true");
    expect(toggled.getAttribute("data-active")).toBe("true");

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
      expect(stored).toEqual(["usdc-circle"]);
    });
    expect(gtag).toHaveBeenCalledWith("event", "yield_watchlist_changed", {
      action: "added",
      coin_id: "usdc-circle",
    });
  });
});
