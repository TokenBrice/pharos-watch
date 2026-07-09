// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getByText("USDT")).toBeTruthy();
    expect(screen.getByText("APY (30d)")).toBeTruthy();
    expect(screen.getByText("4.50%")).toBeTruthy();
    expect(screen.getByText("5.10%")).toBeTruthy();
    expect(screen.getByText("Aave")).toBeTruthy();
    expect(screen.getByText("Morpho")).toBeTruthy();

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

    expect(screen.getByText("Source posture")).toBeTruthy();
    expect(screen.getByText("Speculative")).toBeTruthy();
    expect(screen.getByText("Source risk")).toBeTruthy();
    expect(screen.getByText("42/100 | 1.32x")).toBeTruthy();
    expect(screen.getByText("Venue tier")).toBeTruthy();
    expect(screen.getByText("Medium (3.1/5), partial confidence")).toBeTruthy();
    expect(screen.getByText("Decision reason")).toBeTruthy();
    expect(screen.getByText("Curated source preferred | 1 alternate rejected")).toBeTruthy();
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
    expect(screen.getByText("USDC")).toBeTruthy();
    expect(screen.getAllByTestId("logo")[0].getAttribute("data-src")).toBe("");
  });

  it("exposes a share link mirroring the current compare ids", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    render(<YieldCompareDrawer open onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />);

    const link = screen.getByRole("link", { name: /Share this comparison/i });
    expect(link.getAttribute("href")).toMatch(/\/yield\/?\?compare=usdc-circle%2Cusdt-tether/);
  });

  it("renders nothing when the drawer is closed", () => {
    window.history.replaceState(null, "", "/yield/?compare=usdc-circle,usdt-tether");
    const { container } = render(
      <YieldCompareDrawer open={false} onOpenChange={vi.fn()} rows={[usdc, usdt]} logos={{}} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
