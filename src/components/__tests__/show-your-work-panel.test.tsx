// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShowYourWorkPanel } from "@/components/show-your-work-panel";

afterEach(() => {
  try {
    window.localStorage.removeItem("pharos.show-work");
  } catch {
    /* ignore */
  }
  // Reset URL so other tests start clean.
  window.history.replaceState({}, "", "/");
});

beforeEach(() => {
  // Default URL with the show-work toggle active so the panel renders.
  window.history.replaceState({}, "", "/?show-work=1");
});

describe("ShowYourWorkPanel", () => {
  it("renders liquidity rows with weights and contributions when SYW enabled", () => {
    render(
      <ShowYourWorkPanel
        kind="liquidity"
        scoreComponents={{
          tvlDepth: 80,
          volumeActivity: 60,
          poolQuality: 70,
          durability: 50,
          pairDiversity: 40,
        }}
        stablecoinId="usdc-circle"
        stablecoinName="USDC"
      />,
    );
    expect(screen.getByText(/Inputs · DEX Market Liquidity/i)).toBeTruthy();
    expect(screen.getByText("TVL Depth")).toBeTruthy();
    expect(screen.getByText("80.0")).toBeTruthy();
    // 30% weight column visible.
    expect(screen.getAllByText("30%").length).toBeGreaterThan(0);

    const shell = screen.getByTestId("show-your-work-liquidityScore-table");
    const table = screen.getByRole("table", { name: /DEX market liquidity inputs/i });
    expect(shell.getAttribute("data-table-id")).toBe("show-your-work-liquidityScore");
    expect(table.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
  });

  it("returns null when SYW mode is off", () => {
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("pharos.show-work");
    const { container } = render(
      <ShowYourWorkPanel
        kind="chain-health"
        factors={{
          concentration: 80,
          quality: 70,
          pegStability: 95,
          backingDiversity: 60,
          chainEnvironment: 100,
        }}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
