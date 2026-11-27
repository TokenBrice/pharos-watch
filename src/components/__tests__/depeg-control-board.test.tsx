// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DepegControlBoard, buildDepegExportColumns } from "@/components/depeg/depeg-control-board";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { FX_REOPEN_QUOTE_AT, makeFxCurrentPeg } from "@shared/test-utils/boundary-contract-vectors.test-support";
import { QUALITY_TIER_3_CLASSES, PEG_DEVIATION_TONE_CLASSES } from "@shared/lib/classification";
import { makeDews, makePendingIncident } from "./depeg.test-support";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({ usePrefetchStablecoin: () => vi.fn() }));
afterEach(cleanupFrontendTest);

const makeCoin = (overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin => makePegSummaryCoin({
  id: "coin-a", symbol: "SUSD", name: "Synthetic USD", governance: "decentralized", currentDeviationBps: -6899, pegScore: 0, pegPct: 62.1, eventCount: 607, worstDeviationBps: -6988, activeDepeg: true, lastEventAt: 1_700_000_000, trackingSpanDays: 700,
  dexPriceCheck: { agrees: false, dexPrice: 0.31, dexDeviationBps: -6900, sourcePools: 2, sourceTvl: 1_740_000 }, ...overrides,
});
const makeRow = (coinOverrides: Partial<PegSummaryCoin> = {}, dews: StressSignalEntry | null = makeDews({ score: 43, band: "ALERT", computedAt: 1_700_000_000 })): DepegTrackerRow => ({ coin: makeCoin(coinOverrides), dews });
const boardEl = (rows: DepegTrackerRow[], overrides: Partial<ComponentProps<typeof DepegControlBoard>> = {}) => (
  <DepegControlBoard rows={rows} logos={{}} pegFilter="all" typeFilter="all" searchQuery="" onPegFilterChange={vi.fn()} onTypeFilterChange={vi.fn()} onSearchChange={vi.fn()} onClearFilters={vi.fn()} onRowClick={vi.fn()} nowSeconds={1_700_100_000} {...overrides} />
);
const renderBoard = (rows: DepegTrackerRow[], overrides: Partial<ComponentProps<typeof DepegControlBoard>> = {}) => render(boardEl(rows, overrides));
const getRowFor = (symbol = "SUSD"): HTMLTableRowElement => screen.getByRole("button", { name: `Open ${symbol} depeg detail` }).closest("tr")!;

describe("DepegControlBoard", () => {
  it.each([{ pegScore: 60, tier: "bad" }, { pegScore: 85, tier: "watch" }, { pegScore: 0, tier: "bad" }] as const)("colors peg score $pegScore text and gauge with the same $tier tier", ({ pegScore, tier }) => {
    renderBoard([makeRow({ pegScore })]);
    expect(screen.getByLabelText("Peg score for SUSD").firstElementChild?.className).toContain(QUALITY_TIER_3_CLASSES[tier].bar);
    expect(screen.getAllByText(String(pegScore)).some((el) => el.className.includes(QUALITY_TIER_3_CLASSES[tier].text))).toBe(true);
  });

  it("renders an unavailable peg score as NR with its price reason", () => {
    renderBoard([makeRow({ pegScore: null, currentPriceUnavailable: true })]);
    expect(screen.getAllByTitle("No usable price")[0].textContent).toBe("NR, no usable price");
  });

  it.each(["CALM", "WATCH", "ALERT", "WARNING", "DANGER", null] as const)("counts attention from the canonical %s band, retaining active and pending incidents", (band) => {
    const signal = band == null ? null : makeDews({ band, score: band === "CALM" || band === "WATCH" ? 100 : 0 });
    const pending = makeRow({ id: "pending", symbol: "PENDING", activeDepeg: false }, null);
    pending.pendingIncident = makePendingIncident({ stablecoinId: "pending", symbol: "PENDING" });
    renderBoard([makeRow({ id: "signal", activeDepeg: false }, signal), makeRow({ id: "active", activeDepeg: true }, null), pending]);
    expect(screen.getByText(/need attention/).textContent).toBe(`${band === "ALERT" || band === "WARNING" || band === "DANGER" ? 3 : 2} need attention`);
  });

  it.each([{ currentDeviationBps: null, dews: null }, { currentDeviationBps: null, dews: makeDews({ score: 0, band: "CALM" }) }, { currentDeviationBps: 0, dews: null }])("does not claim clear health with incomplete live observations: %j", ({ currentDeviationBps, dews }) => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps, pegScore: null }, dews)]);
    const row = within(getRowFor());
    expect(row.getByText("unknown")).toBeTruthy();
    expect(row.queryByText("clear")).toBeNull();
  });

  it("distinguishes observed zero readings from unavailable deviation in health status and tone", () => {
    const calm = makeDews({ score: 0, band: "CALM" }), view = renderBoard([makeRow({ activeDepeg: false, currentDeviationBps: 0 }, calm)]);
    const zeroRow = within(getRowFor());
    expect(zeroRow.getByText("clear")).toBeTruthy(); expect(zeroRow.queryByText("unknown")).toBeNull();
    for (const el of zeroRow.getAllByText("0 bps")) expect(el.className).toContain(PEG_DEVIATION_TONE_CLASSES.healthy.text);
    view.rerender(boardEl([makeRow({ activeDepeg: false, currentDeviationBps: null, pegScore: null }, calm)]));
    for (const el of within(getRowFor()).getAllByText("—")) expect(el.className).not.toContain(PEG_DEVIATION_TONE_CLASSES.healthy.text);
  });

  it("derives a pending incident's age from firstSeenAt on the page clock", () => {
    const NOW = 1_700_100_000, row = makeRow({ activeDepeg: false, currentDeviationBps: 0 }, null);
    row.pendingIncident = makePendingIncident({ stablecoinId: row.coin.id, symbol: row.coin.symbol, firstSeenAt: NOW - 720, ageSec: 60 });
    const view = renderBoard([row], { nowSeconds: NOW });
    expect(within(getRowFor()).getByText("12m")).toBeTruthy(); expect(within(getRowFor()).queryByText("1m")).toBeNull();
    view.rerender(boardEl([row], { nowSeconds: NOW + 600 })); expect(within(getRowFor()).getByText("22m")).toBeTruthy();
  });

  it.each(["open", "awaiting", "floor", "warning", "danger"] as const)("preserves the known %s status ahead of unknown observations", (status) => {
    const row = makeRow({ activeDepeg: status === "open", depegEventCoverageLimited: status === "floor", currentDeviationBps: null, pegScore: null }, status === "warning" || status === "danger" ? makeDews({ band: status === "warning" ? "WARNING" : "DANGER" }) : null);
    if (status === "awaiting") row.pendingIncident = makePendingIncident({ stablecoinId: row.coin.id, symbol: row.coin.symbol });
    renderBoard([row]); const rendered = within(getRowFor());
    expect(rendered.getByText(status)).toBeTruthy(); expect(rendered.queryByText("unknown")).toBeNull();
  });

  it.each([["outside", "Observed outside recovery band"], ["inside", "Inside recovery band, awaiting confirmation"], ["unconfirmed", "Recovery unconfirmed"], [null, "Recovery unconfirmed"]] as const)("labels an open incident's %s evidence beside its lifecycle pill", (evidence, label) => {
    const row = makeRow({ activeDepeg: true, currentDeviationBps: 0 }); row.openIncidentEvidence = evidence;
    renderBoard([row]); const rendered = within(getRowFor());
    expect(rendered.getByText("open")).toBeTruthy(); expect(rendered.getByText(label)).toBeTruthy(); expect(rendered.queryByText("live")).toBeNull();
  });

  it("adds no incident evidence to rows without an open incident", () => {
    const row = makeRow({ activeDepeg: false }); row.openIncidentEvidence = "outside";
    renderBoard([row]); expect(within(getRowFor()).queryByText("Observed outside recovery band")).toBeNull();
  });

  it.each([1, 2])("labels %s DEX check observations as price sources", (sourcePools) => {
    renderBoard([makeRow({ dexPriceCheck: { agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools, sourceTvl: 1_740_000 } })]);
    const row = within(getRowFor());
    expect(row.getByText(`${sourcePools} price ${sourcePools === 1 ? "source" : "sources"} · $1.74M`)).toBeTruthy();
    expect(row.queryByText(/\b\d+ pools?\b/)).toBeNull();
  });

  it("renders unknown peg occupancy as unavailable rather than zero or perfect stability", () => {
    renderBoard([makeRow({ pegScore: null, pegPct: null })]);
    const btn = screen.getByRole("button", { name: /open susd depeg detail/i });
    expect(within(btn.closest("tr")!).getByText("-")).toBeTruthy();
    const desc = document.getElementById(btn.getAttribute("aria-describedby")!)!;
    expect(desc.textContent).toMatch(/-\s*at peg.*recorded-window peg occupancy estimate/i);
    expect(desc.textContent).not.toMatch(/0\.0%|100\.0%/);
  });

  it.each([{ pegPct: 99.8, activeDepeg: false, currentDeviationBps: 0 }, { pegPct: 100, activeDepeg: false, currentDeviationBps: null }, { pegPct: 0, activeDepeg: true, currentDeviationBps: -500 }])("renders concise at-peg subline while keeping occupancy %s record-derived and accessible", (coin) => {
    renderBoard([makeRow(coin)]);
    const btn = screen.getByRole("button", { name: /open susd depeg detail/i }), desc = document.getElementById(btn.getAttribute("aria-describedby")!)!;
    expect(desc.textContent).toContain(`${coin.pegPct.toFixed(1)}% at peg`);
    expect(desc.textContent).toMatch(/recorded-window peg occupancy estimate/i);
    expect(desc.textContent).toMatch(/tracking closure can leave unobserved time/i);
    expect(desc.textContent).toMatch(/not proof of recovery or continuous observation/i);
    expect(within(btn.closest("tr")!).queryByText(/recovered|coverage lost|asset removed|direction superseded/i)).toBeNull();
  });

  it.each([[276_400_000, "$276.4M cap"], [null, "cap unavailable"]] as const)("labels market cap %s without zero-filling", (marketCapUsd, label) => {
    renderBoard([{ ...makeRow(), marketCapUsd }]);
    expect(within(getRowFor()).getByText(label)).toBeTruthy();
  });

  it("renders clickable sort headers, reverses attention ordering, and exposes export menu", () => {
    renderBoard([makeRow({ id: "active", symbol: "LIVE", name: "Live Asset", activeDepeg: true }), makeRow({ id: "clear", symbol: "CLEAR", name: "Clear Asset", currentDeviationBps: 0, activeDepeg: false, eventCount: 0, pegScore: 100, pegPct: 100 }, makeDews({ score: 0, band: "CALM" }))]);
    expect(within(getRowFor("LIVE")).getByText("worst -6988 bps")).toBeTruthy();
    for (const label of ["Asset", "Deviation", "DEWS", "Peg health", "Events", "DEX check"]) expect(screen.getByRole("button", { name: `Sort by ${label}` })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export table as CSV, NDJSON, or Markdown/i })).toBeTruthy();
    expect(screen.queryByText("Peg score")).toBeNull();
    const assetHeaderBtn = screen.getByRole("button", { name: "Sort by Asset" });
    expect(assetHeaderBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(within(screen.getAllByRole("button", { name: /open .* depeg detail/i })[0]).getByText("LIVE")).toBeTruthy();
    fireEvent.click(assetHeaderBtn);
    expect(assetHeaderBtn.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    expect(within(screen.getAllByRole("button", { name: /open .* depeg detail/i })[0]).getByText("CLEAR")).toBeTruthy();
  });

  it("filters rows by Status segmented control without misclassifying unknown deviations", () => {
    const pending = makeRow({ id: "pending", symbol: "PND", activeDepeg: false, currentDeviationBps: -130 }, makeDews({ score: 15, band: "WATCH" }));
    pending.pendingIncident = makePendingIncident({ stablecoinId: "pending", symbol: "PND" });
    renderBoard([
      makeRow({ id: "active", symbol: "ACT", activeDepeg: true, currentDeviationBps: -400 }, makeDews({ score: 20, band: "WATCH" })),
      pending,
      makeRow({ id: "alert", symbol: "ALRT", activeDepeg: false, currentDeviationBps: -20 }, makeDews({ score: 50, band: "ALERT" })),
      makeRow({ id: "calm", symbol: "CALM", activeDepeg: false, currentDeviationBps: 5 }, makeDews({ score: 5, band: "CALM" })),
      makeRow({ id: "unk", symbol: "UNK", activeDepeg: false, currentDeviationBps: null }, makeDews({ score: 0, band: "CALM" })),
    ]);
    const statusGroup = within(screen.getByRole("group", { name: "Filter by peg status" }));
    const visible = () => screen.getAllByRole("button", { name: /open .* depeg detail/i }).map((el) => el.getAttribute("aria-label"));
    expect(visible()).toHaveLength(5);
    for (const [button, expected] of [["Recent / Pending", ["Open ACT depeg detail", "Open PND depeg detail"]], ["DEWS Alert+", ["Open ALRT depeg detail"]], ["At peg", ["Open ALRT depeg detail", "Open CALM depeg detail"]]] as const) {
      fireEvent.click(statusGroup.getByRole("button", { name: button }));
      expect(visible()).toEqual(expected);
    }
    fireEvent.click(statusGroup.getByRole("button", { name: "All" }));
    expect(visible()).toHaveLength(5);
  });

  it("counts below-floor rows in the same filtered universe as the attention figure", () => {
    renderBoard([makeRow({ id: "gold-floor", symbol: "GOLDF", pegCurrency: "GOLD", depegEventCoverageLimited: true, activeDepeg: false, currentDeviationBps: 0 }, null)], { pegFilter: "GOLD" });
    expect(screen.getByText(/need attention/).textContent).toBe("0 filtered coins need attention · 1 below the event-history floor");
  });

  it("discloses unavailable horizon split and renders Escalating/>30d filters", () => {
    const D = 86_400, now = 1_700_100_000, rows = () => screen.queryAllByRole("button", { name: /open .* depeg detail/i }).map((e) => e.getAttribute("aria-label"));
    const act = makeRow({ id: "act", symbol: "ACT", activeDepeg: true }, null);
    const pnd: DepegTrackerRow = { ...makeRow({ id: "pnd", symbol: "PND", activeDepeg: false }, null), pendingIncident: makePendingIncident({ stablecoinId: "pnd", symbol: "PND" }) };
    const v = renderBoard([act, pnd], { statusFilter: "recent_pending" });
    expect(rows()).toEqual(["Open ACT depeg detail", "Open PND depeg detail"]);
    expect(screen.getByText("Open-incident horizon split is unavailable for this snapshot; showing all active and pending incidents.")).toBeTruthy();
    v.rerender(boardEl([], { statusFilter: "recent_pending", searchQuery: "zzz" }));
    expect(screen.getByText("No stablecoins match these filters.")).toBeTruthy();
    v.rerender(boardEl([act, pnd], { statusFilter: "long_running" }));
    expect(rows()).toEqual([]);
    expect(screen.getByText("Open-incident horizon split is unavailable for this snapshot. Clear filters or select All to inspect active incidents.")).toBeTruthy();
    const esc: DepegTrackerRow = { ...makeRow({ id: "esc", symbol: "ESC", activeDepeg: true }), openIncidentTier: "escalating", openIncidentStartedAt: now - 45 * D };
    const old: DepegTrackerRow = { ...makeRow({ id: "old", symbol: "OLD", activeDepeg: true }), openIncidentTier: "long_running", openIncidentStartedAt: now - 90 * D };
    v.rerender(boardEl([esc, old], { nowSeconds: now, statusFilter: "recent_pending" }));
    expect(getRowFor("ESC").textContent).toMatch(/Escalating.*45d ago/);
    v.rerender(boardEl([esc, old], { nowSeconds: now, statusFilter: "long_running" }));
    expect(getRowFor("OLD").textContent).toMatch(/>30d.*90d ago/);
    v.rerender(boardEl([esc, old], { nowSeconds: now, statusFilter: "active_pending" }));
    expect(rows()).toHaveLength(2);
    // Expired FX quote withholds bps on display, ranks Tier 1 ahead of near-par Tier 0, and exports null.
    const tFx = FX_REOPEN_QUOTE_AT + 7_141;
    const fxRow = makeRow({ id: "eurc-circle", symbol: "EURC", pegCurrency: "EUR", activeDepeg: true, priceObservedAt: FX_REOPEN_QUOTE_AT, ...makeFxCurrentPeg("admitted", 25, FX_REOPEN_QUOTE_AT) } as Partial<PegSummaryCoin>, null);
    const parRow = makeRow({ id: "usdc-circle", symbol: "USDC", pegCurrency: "USD", activeDepeg: true, currentDeviationBps: -10 }, null);
    v.rerender(boardEl([parRow, fxRow], { nowSeconds: tFx, statusFilter: "all" }));
    expect(rows()).toEqual(["Open EURC depeg detail", "Open USDC depeg detail"]);
    expect(getRowFor("EURC").textContent).toContain("Reference not yet updated");
    expect(getRowFor("EURC").textContent).not.toContain("25 bps");
    expect(buildDepegExportColumns(tFx).find((c) => c.header === "Current Deviation (bps)")?.accessor(fxRow, 0)).toBeNull();
  });
});
