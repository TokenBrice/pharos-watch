// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MintBurnCoinFlow } from "@shared/types";
import { FlowTable } from "@/components/flow-table";
import { makeMintBurnCoinValuation } from "@/test-utils/mint-burn-fixtures";

vi.mock("next/link", async () => (await import("@/test-utils/frontend")).createNextLinkMock());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/logos", () => ({
  logosById: {},
}));

const prefetch = vi.fn();
vi.mock("@/hooks/use-prefetch-stablecoin", () => ({ usePrefetchStablecoin: () => prefetch }));

const coin = {
  stablecoinId: "usdt-tether",
  symbol: "USDT",
  pressureShiftScore: -18,
  pressureShiftState: "worsening" as const,
  netFlowDirection24h: "burning" as const,
  has24hActivity: true,
  baselineDailyNetUsd: 0,
  baselineDailyAbsUsd: 10_000_000,
  baselineDataDays: 14,
  netFlow24hUsd: -12_000_000,
  mintVolume24hUsd: 8_000_000,
  burnVolume24hUsd: 20_000_000,
  mintCount24h: 4,
  burnCount24h: 6,
  netFlow7dUsd: -15_000_000,
  netFlow30dUsd: -30_000_000,
  netFlow90dUsd: -45_000_000,
  largestEvent24h: null,
  coverage: {
    startBlock: 21_900_000,
    lastSyncedBlock: 22_000_000,
    lagBlocks: 0,
    historyStartAt: 1_700_000_000,
    has24hWindow: true,
    has30dWindow: false,
    has90dWindow: false,
    isPartial: true,
    status: "partial-history" as const,
  },
};

const table = (coins: MintBurnCoinFlow[]) => renderToStaticMarkup(<FlowTable coins={coins} isLoading={false} />);

describe("FlowTable", () => {
  it("exposes legacy pre-cutover scan provenance on the coin pressure tooltip", () => {
    const html = table([{
      ...coin, coverage: { ...coin.coverage, provenance: "legacy-pre-cutover" },
    }]);
    expect(html).toContain('title="24h scan evidence uses legacy pre-cutover coverage, not durable-v2 scan proof."');
  });

  it("uses the window-specific provenance before the coin-wide fallback", () => {
    const durable = { complete: true, unavailableReason: null, provenance: "durable-v2" } as const;
    const html = table([{
      ...coin, coverage: { ...coin.coverage, provenance: "legacy-pre-cutover",
        windows: { window24h: durable, window7d: durable, window30d: durable, window90d: durable } },
    }]);
    expect(html).not.toContain("not durable-v2 scan proof");
  });

  it("labels colliding tickers by registry identity even when only one collision member is shown", () => {
    const html = table([{ ...coin, stablecoinId: "ousd-open-standard", symbol: "OUSD" }]);
    expect(html).toContain("OUSD (Open USD)");
    expect(html).toContain('aria-label="Open OUSD (Open USD) flow detail"');
  });

  it("renders coverage badge and partial long-window indicators", () => {
    const { container } = render(<FlowTable coins={[coin]} isLoading={false} />);
    const link = screen.getByRole("link", { name: "Open USDT flow detail" }), row = link.closest("tr")!;
    expect(link.getAttribute("href")).toBe("/stablecoin/usdt-tether/");
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toContain(row);
    expect(screen.getAllByRole("columnheader")).toHaveLength(9);
    expect(within(row).getAllByRole("cell")).toHaveLength(9);
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.focus(link);
    fireEvent.mouseEnter(row);
    expect(prefetch.mock.calls).toEqual([[coin.stablecoinId], [coin.stablecoinId]]);
    const html = container.innerHTML;
    expect(html).toContain("Partial history");
    expect((html.match(/partial/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders a burn-side partial 24h net as an upper bound and its incomplete volume as a lower bound", () => {
    const html = table([{
      ...coin,
      valuation: makeMintBurnCoinValuation(
        { completeness: "partial", burnCompleteness: "partial", unpricedBurnEventCount: 3 },
        { netFlow7d: "partial" },
      ),
    }]);

    // Only burns are unpriced, so the known net is a ceiling: shown as "≤", never as the net itself.
    for (const text of ["≤ -$12.00M", "Upper bound: 0 mint / 3 burn events unpriced; unpriced burns can only lower the net", "≥ $20.00M", "-$30.00M"]) expect(html).toContain(text);
    for (const text of ["-$15.00M", "≥ $8.00M"]) expect(html).not.toContain(text);
    expect(html.replaceAll("≤ -$12.00M", "")).not.toContain("-$12.00M");
  });

  it("renders a null net as unavailable instead of $0", () => {
    const html = table([{ ...coin, netFlow24hUsd: null, netFlowDirection24h: null }]);

    expect(html).not.toContain("$0.00");
    expect(html).toContain("Signed net unavailable");
  });

  it("retains unknown scan activity in the default table instead of hiding it as idle", () => {
    const unknown = {
      ...coin,
      has24hActivity: null,
      netFlowDirection24h: null,
      pressureShiftScore: null,
      pressureShiftState: "nr" as const,
      mintVolume24hUsd: 0,
      burnVolume24hUsd: 0,
      mintCount24h: 0,
      burnCount24h: 0,
      netFlow24hUsd: null,
      netFlow7dUsd: null,
      netFlow30dUsd: null,
      netFlow90dUsd: null,
      valuation: makeMintBurnCoinValuation(),
    };
    const html = table([unknown, { ...unknown, stablecoinId: "usdc-circle", symbol: "USDC", has24hActivity: false, netFlow24hUsd: 0 }]);
    for (const text of ['aria-label="Open USDT flow detail"', 'data-reason-codes="activity-unknown"', "signed net unavailable"]) expect(html).toContain(text);
    expect(html).not.toContain('aria-label="Open USDC flow detail"');
  });

  it.each([0, 100])("labels fully priced unscanned gross volumes (%i) as observed lower bounds", (volume) => {
    const incomplete = { complete: false, unavailableReason: "scan-coverage-incomplete" as const };
    const html = table([{
      ...coin,
      has24hActivity: null,
      observed24hActivity: volume > 0,
      netFlow24hUsd: null,
      netFlowDirection24h: null,
      mintVolume24hUsd: volume,
      burnVolume24hUsd: 0,
      totalsSemantics: "observed-subtotals",
      valuation: makeMintBurnCoinValuation(),
      coverage: { ...coin.coverage, has24hWindow: false, windows: {
        window24h: incomplete, window7d: incomplete, window30d: incomplete, window90d: incomplete,
      } },
    }]);
    for (const text of [`≥ $${volume.toFixed(2)}`, "≥ $0.00", "Observed subtotal, lower bound: scan coverage incomplete"]) expect(html).toContain(text);
    expect(html).not.toContain("events unpriced");
  });

  it("ranks worst pressure against the 30-day norm first, with NR last", () => {
    const html = table([
      { ...coin, stablecoinId: "usdc-circle", symbol: "USDC", pressureShiftScore: 12, pressureShiftState: "improving" },
      { ...coin, stablecoinId: "dai-makerdao", symbol: "DAI", pressureShiftScore: null, pressureShiftState: "nr" },
      { ...coin, pressureShiftScore: -60 },
    ]);

    const order = ["USDT", "USDC", "DAI"].map((symbol) => html.indexOf(`Open ${symbol} flow detail`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("names coverage-unknown nets once per column instead of a * on each cell", () => {
    // A payload without `valuation` is coverage-unknown on every window.
    const html = table([coin]);

    expect((html.match(/data-reason-codes="valuation-unknown"/g) ?? []).length).toBe(4);
    expect(html).toContain("Unverified");
    expect(html).not.toMatch(/align-super[^>]*>\*</);
    // The per-cell reason stays available to assistive tech.
    expect(html).toContain("(coverage unknown)");
  });
});
