// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { YieldCompareDrawer } from "@/components/yield-compare-drawer";
import type { YieldViewModelRow } from "@/lib/yield-view-model";

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  SheetFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/stablecoin-logo", () => ({
  StablecoinLogo: ({ name, src }: { name: string; src?: string }) => (
    <span data-testid="logo" data-src={src ?? ""}>
      {name}
    </span>
  ),
}));

function makeRow(overrides: Partial<YieldViewModelRow>): YieldViewModelRow {
  return {
    id: overrides.id ?? "usdc-circle",
    symbol: overrides.symbol ?? "USDC",
    name: overrides.name ?? "USD Coin",
    apy30d: 4.5,
    pharosYieldScore: 78,
    safetyScore: 82,
    safetyGrade: "A",
    yieldSource: "Aave",
    sourceTvlUsd: 10_000_000,
    sourceDepthLens: "moderate",
    sourcePosture: "clean",
    yieldStability: 0.92,
    warningSignals: [],
    benchmarkLabel: "USD 3M T-Bill",
    ...overrides,
  } as unknown as YieldViewModelRow;
}

const usdc = makeRow({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" });
const usdt = makeRow({
  id: "usdt-tether",
  symbol: "USDT",
  name: "Tether",
  apy30d: 5.1,
  pharosYieldScore: 71,
  safetyGrade: "B+",
  safetyScore: 76,
  yieldSource: "Morpho",
});

beforeEach(() => {
  window.history.replaceState(null, "", "/yield/");
});

afterEach(() => {
  cleanup();
});

describe("YieldCompareDrawer", () => {
  it("renders metric rows side-by-side for the selected coins", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />);

    expect(screen.getByText("Compare yield sources")).toBeTruthy();
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USDT").length).toBeGreaterThan(0);
    expect(screen.getAllByText("APY (30d)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4.50%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5.10%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Aave").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Morpho").length).toBeGreaterThan(0);

    const shell = screen.getByTestId("yield-compare-drawer-table");
    const table = screen.getByRole("table", { name: "Yield source comparison" });
    expect(shell.getAttribute("data-table-id")).toBe("yield-compare-drawer");
    expect(table.parentElement?.getAttribute("data-slot")).toBe("table-viewport");
  });

  it("renders source posture, material source risk, venue tier, and decision reason rows", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle");
    render(
      <YieldCompareDrawer
        open
        onOpenChange={vi.fn()}
        rows={[
          makeRow({
            sourcePosture: "speculative",
            sourceRisk: {
              sourceRiskScore: 42,
              sourceRiskPenalty: 1.32,
              venueRiskTier: "medium",
              venueRiskWeighted: 3.1,
              venueRiskConfidence: "partial",
            },
            decisionLedger: {
              selectedReasonCode: "curated-over-discovered",
              sourceSwitch: false,
              rejectedCount: 1,
              alternatives: [],
            },
          } as Partial<YieldViewModelRow>),
        ]}
        logos={{}}
      />,
    );

    expect(screen.getAllByText("Source posture").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Speculative").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Source risk").length).toBeGreaterThan(0);
    expect(screen.getAllByText("42/100 | 1.32x").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Venue tier").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Medium (3.1/5), partial confidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Decision reason").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Curated source preferred | 1 alternate rejected").length).toBeGreaterThan(0);
  });

  it("shows PYS evidence qualification and keeps remove controls touch-sized", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle");
    render(
      <YieldCompareDrawer
        open
        onOpenChange={vi.fn()}
        rows={[
          makeRow({
            provenance: {
              scoreQualification: "partial",
              evidenceCompleteness: 0.71,
            },
          } as Partial<YieldViewModelRow>),
        ]}
        logos={{}}
      />,
    );

    expect(screen.getAllByText("PYS qualification").length).toBeGreaterThan(0);
    expect(screen.getAllByText("partial (71% complete)").length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole("button", { name: "Remove USDC from compare" })) {
      expect(button.className).toContain("h-11");
      expect(button.className).toContain("w-11");
    }
  });

  it("renders 'Coin not in current view' placeholder when a selected id is filtered out", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,absent-coin");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc]} logos={{}} />);

    const placeholders = screen.getAllByText("Coin not in current view");
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it("does not pass inherited logo properties as image sources", () => {
    window.history.replaceState(null, "", "/yield/?compare=__proto__,usdc-circle");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc]} logos={{}} />);

    expect(screen.getAllByText("__proto__").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("logo")[0].getAttribute("data-src")).toBe("");
  });

  it("copies a shareable comparison URL when Web Share is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />);

    fireEvent.click(screen.getByRole("button", { name: "Share comparison" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/yield\/?\?compare=usdc-circle%2Cusdt-tether/));
      expect(screen.getByRole("button", { name: "Link copied" })).toBeTruthy();
    });
  });

  it("renders stacked comparison summaries for narrow layouts", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />);

    expect(screen.getByTestId("yield-compare-mobile-list")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Remove .* from compare/ })).toHaveLength(4);
  });

  it("renders nothing when the drawer is closed", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    const { container } = render(
      <YieldCompareDrawer open={false} onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
