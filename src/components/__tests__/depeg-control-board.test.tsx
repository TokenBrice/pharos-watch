// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { DepegControlBoard } from "@/components/depeg/depeg-control-board";
import { cleanupFrontendTest } from "@/test-utils/frontend";
import type { DepegTrackerRow } from "@/lib/depeg-sort";
import type { PegSummaryCoin } from "@shared/types/peg";
import type { StressSignalEntry } from "@shared/types/stress";
import { makePegSummaryCoin } from "@/test-utils/peg-summary-fixtures";
import { QUALITY_TIER_3_CLASSES, PEG_DEVIATION_TONE_CLASSES } from "@shared/lib/classification";
import { makeDews, makePendingIncident } from "./depeg.test-support";

vi.mock("@/hooks/use-prefetch-stablecoin", () => ({
  usePrefetchStablecoin: () => vi.fn(),
}));

afterEach(() => {
  cleanupFrontendTest();
});

function makeCoin(overrides: Partial<PegSummaryCoin> = {}): PegSummaryCoin {
  return makePegSummaryCoin({
    id: "coin-a",
    symbol: "SUSD",
    name: "Synthetic USD",
    governance: "decentralized",
    currentDeviationBps: -6899,
    pegScore: 0,
    pegPct: 62.1,
    eventCount: 607,
    worstDeviationBps: -6988,
    activeDepeg: true,
    lastEventAt: 1_700_000_000,
    trackingSpanDays: 700,
    dexPriceCheck: { agrees: false, dexPrice: 0.31, dexDeviationBps: -6900, sourcePools: 2, sourceTvl: 1_740_000 },
    ...overrides,
  });
}


function makeRow(
  coinOverrides: Partial<PegSummaryCoin> = {},
  dews: StressSignalEntry | null = makeDews({ score: 43, band: "ALERT", computedAt: 1_700_000_000 }),
): DepegTrackerRow {
  return {
    coin: makeCoin(coinOverrides),
    dews,
  };
}

function renderBoard(
  rows: DepegTrackerRow[],
  overrides: Partial<ComponentProps<typeof DepegControlBoard>> = {},
) {
  return render(
    <DepegControlBoard
      rows={rows}
      logos={{}}
      pegFilter="all"
      typeFilter="all"
      searchQuery=""
      onPegFilterChange={vi.fn()}
      onTypeFilterChange={vi.fn()}
      onSearchChange={vi.fn()}
      onClearFilters={vi.fn()}
      onRowClick={vi.fn()}
      nowSeconds={1_700_100_000}
      {...overrides}
    />,
  );
}

function getRowFor(symbol = "SUSD"): HTMLTableRowElement {
  return screen.getByRole("button", { name: `Open ${symbol} depeg detail` }).closest("tr")!;
}

describe("DepegControlBoard", () => {
  it.each([
    { pegScore: 60, tier: "bad" },
    { pegScore: 85, tier: "watch" },
    { pegScore: 0, tier: "bad" },
  ] as const)("colors peg score $pegScore text and gauge with the same $tier tier", ({ pegScore, tier }) => {
    renderBoard([makeRow({ pegScore })]);
    const gauge = screen.getByLabelText("Peg score for SUSD");
    expect(gauge.firstElementChild?.className).toContain(QUALITY_TIER_3_CLASSES[tier].bar);
    const text = screen.getAllByText(String(pegScore)).find((el) => el.className.includes(QUALITY_TIER_3_CLASSES[tier].text));
    expect(text).toBeDefined();
  });

  it("renders an unavailable peg score as NR with a neutral gauge and its price reason", () => {
    renderBoard([makeRow({ pegScore: null, currentPriceUnavailable: true })]);
    expect(screen.getByLabelText("Peg score for SUSD").firstElementChild?.className).toContain("bg-muted-foreground");
    expect(screen.getAllByTitle("No usable price")[0].textContent).toBe("NR, no usable price");
  });

  it.each(["CALM", "WATCH", "ALERT", "WARNING", "DANGER", null] as const)(
    "counts attention from the canonical %s band, retaining active and pending incidents",
    (band) => {
      // Deliberately disagree with the score so a duplicated numeric threshold cannot pass.
      const signal = band == null ? null : makeDews({ band, score: band === "CALM" || band === "WATCH" ? 100 : 0 });
      const pending = makeRow({ id: "pending", symbol: "PENDING", activeDepeg: false }, null);
      pending.pendingIncident = makePendingIncident({ stablecoinId: "pending", symbol: "PENDING" });
      renderBoard([
        makeRow({ id: "signal", activeDepeg: false }, signal),
        makeRow({ id: "active", activeDepeg: true }, null),
        pending,
      ]);
      const expected = band === "ALERT" || band === "WARNING" || band === "DANGER" ? 3 : 2;
      expect(screen.getByText(/need attention/).textContent).toBe(`${expected} need attention`);
    },
  );

  it.each([
    { currentDeviationBps: null, dews: null },
    { currentDeviationBps: null, dews: makeDews({ score: 0, band: "CALM" }) },
    { currentDeviationBps: 0, dews: null },
  ])("does not claim clear health with incomplete live observations: %j", ({ currentDeviationBps, dews }) => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps, pegScore: null }, dews)]);
    const row = getRowFor();
    expect(within(row).getByText("unknown")).toBeTruthy();
    expect(within(row).queryByText("clear")).toBeNull();
  });

  it("distinguishes observed zero readings from unknown health", () => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps: 0 }, makeDews({ score: 0, band: "CALM" }))]);
    const row = getRowFor();
    expect(within(row).getByText("clear")).toBeTruthy();
    expect(within(row).queryByText("unknown")).toBeNull();
  });

  it("does not paint an unavailable live deviation with the healthy tone", () => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps: null, pegScore: null }, makeDews({ score: 0, band: "CALM" }))]);
    const row = getRowFor();
    const values = within(row).getAllByText("—");
    for (const deviation of values) {
      expect(deviation.className).toContain("text-muted-foreground");
      expect(deviation.className).not.toContain(PEG_DEVIATION_TONE_CLASSES.healthy.text);
    }
  });

  it("keeps the healthy tone for an observed zero deviation", () => {
    renderBoard([makeRow({ activeDepeg: false, currentDeviationBps: 0 }, makeDews({ score: 0, band: "CALM" }))]);
    const row = getRowFor();
    for (const value of within(row).getAllByText("0 bps")) {
      expect(value.className).toContain(PEG_DEVIATION_TONE_CLASSES.healthy.text);
    }
  });

  it("derives a pending incident's age from firstSeenAt on the page clock", () => {
    const NOW = 1_700_100_000;
    const row = makeRow({ activeDepeg: false, currentDeviationBps: 0 }, null);
    row.pendingIncident = makePendingIncident({
      stablecoinId: row.coin.id,
      symbol: row.coin.symbol,
      firstSeenAt: NOW - 720,
      ageSec: 60,
    });
    const view = renderBoard([row], { nowSeconds: NOW });
    expect(within(getRowFor()).getByText("12m")).toBeTruthy();
    expect(within(getRowFor()).queryByText("1m")).toBeNull();

    view.rerender(
      <DepegControlBoard
        rows={[row]}
        logos={{}}
        pegFilter="all"
        typeFilter="all"
        searchQuery=""
        onPegFilterChange={vi.fn()}
        onTypeFilterChange={vi.fn()}
        onSearchChange={vi.fn()}
        onClearFilters={vi.fn()}
        onRowClick={vi.fn()}
        nowSeconds={NOW + 600}
      />,
    );
    expect(within(getRowFor()).getByText("22m")).toBeTruthy();
  });

  it.each(["open", "awaiting", "floor", "warning", "danger"] as const)(
    "preserves the known %s status ahead of unknown observations",
    (status) => {
      const row = makeRow({
        activeDepeg: status === "open",
        depegEventCoverageLimited: status === "floor",
        currentDeviationBps: null,
        pegScore: null,
      }, status === "warning" || status === "danger"
        ? makeDews({ band: status === "warning" ? "WARNING" : "DANGER" })
        : null);
      if (status === "awaiting") {
        row.pendingIncident = makePendingIncident({ stablecoinId: row.coin.id, symbol: row.coin.symbol });
      }
      renderBoard([row]);
      const renderedRow = getRowFor();
      expect(within(renderedRow).getByText(status)).toBeTruthy();
      expect(within(renderedRow).queryByText("unknown")).toBeNull();
    },
  );

  it.each([
    ["outside", "Observed outside recovery band"],
    ["inside", "Inside recovery band, awaiting confirmation"],
    ["unconfirmed", "Recovery unconfirmed"],
    [null, "Recovery unconfirmed"],
  ] as const)("labels an open incident's %s evidence beside its lifecycle pill", (evidence, label) => {
    const row = makeRow({ activeDepeg: true, currentDeviationBps: 0 });
    row.openIncidentEvidence = evidence;
    renderBoard([row]);
    const renderedRow = getRowFor();
    expect(within(renderedRow).getByText("open")).toBeTruthy();
    expect(within(renderedRow).getByText(label)).toBeTruthy();
    expect(within(renderedRow).queryByText("live")).toBeNull();
  });

  it("adds no incident evidence to rows without an open incident", () => {
    const row = makeRow({ activeDepeg: false });
    row.openIncidentEvidence = "outside";
    renderBoard([row]);
    const renderedRow = getRowFor();
    expect(within(renderedRow).queryByText("Observed outside recovery band")).toBeNull();
  });

  it.each([1, 2])("labels %s DEX check observations as price sources", (sourcePools) => {
    renderBoard([makeRow({
      dexPriceCheck: { agrees: true, dexPrice: 1, dexDeviationBps: 0, sourcePools, sourceTvl: 1_740_000 },
    })]);
    const row = getRowFor();
    const label = `${sourcePools} price ${sourcePools === 1 ? "source" : "sources"} · $1.74M`;
    expect(within(row).getByText(label)).toBeTruthy();
    expect(within(row).queryByText(/\b\d+ pools?\b/)).toBeNull();
  });

  it("renders unknown peg occupancy as unavailable rather than zero or perfect stability", () => {
    renderBoard([makeRow({ pegScore: null, pegPct: null })]);
    const btn = screen.getByRole("button", { name: /open susd depeg detail/i });
    const row = btn.closest("tr")!;
    expect(within(row).getByText("-")).toBeTruthy();
    const description = document.getElementById(btn.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toMatch(/-\s*at peg.*recorded-window peg occupancy estimate/i);
    expect(description.textContent).not.toMatch(/0\.0%|100\.0%/);
  });

  it.each([
    { pegPct: 99.8, activeDepeg: false, currentDeviationBps: 0 },
    { pegPct: 100, activeDepeg: false, currentDeviationBps: null },
    { pegPct: 0, activeDepeg: true, currentDeviationBps: -500 },
  ])("renders concise at-peg subline while keeping occupancy %s record-derived and accessible", (coin) => {
    renderBoard([makeRow(coin)]);
    const btn = screen.getByRole("button", { name: /open susd depeg detail/i });
    const row = btn.closest("tr")!;
    const description = document.getElementById(btn.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain(`${coin.pegPct.toFixed(1)}% at peg`);
    expect(description.textContent).toMatch(/recorded-window peg occupancy estimate/i);
    expect(description.textContent).toMatch(/tracking closure can leave unobserved time/i);
    expect(description.textContent).toMatch(/not proof of recovery or continuous observation/i);
    // The verbose caveat is accessible description, not visible per-row copy.
    expect(within(description).getByText(/tracking closure/i).className).toContain("sr-only");
    expect(within(row).queryByText(/recovered|coverage lost|asset removed|direction superseded/i)).toBeNull();
  });

  it.each([[276_400_000, "$276.4M cap"], [null, "cap unavailable"]] as const)("labels market cap %s without zero-filling", (marketCapUsd, label) => {
    renderBoard([{ ...makeRow(), marketCapUsd }]);
    expect(within(getRowFor()).getByText(label)).toBeTruthy();
  });

  it("renders rows inside DataTableShell with clickable sort headers and export menu", () => {
    renderBoard([makeRow()]);

    expect(screen.getByText("worst -6988 bps")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by Asset" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by Deviation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by DEWS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by Peg health" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by Events" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sort by DEX check" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export table as CSV, NDJSON, or Markdown/i })).toBeTruthy();
    expect(screen.queryByText("Peg score")).toBeNull();
  });

  it("shows truthful sort direction via clickable column headers and reverses attention ordering", () => {
    renderBoard([
      makeRow({ id: "active", symbol: "LIVE", name: "Live Asset", activeDepeg: true }),
      makeRow({ id: "clear", symbol: "CLEAR", name: "Clear Asset", currentDeviationBps: 0, activeDepeg: false, eventCount: 0, pegScore: 100, pegPct: 100 }, makeDews({ score: 0, band: "CALM" })),
    ]);

    const assetHeaderBtn = screen.getByRole("button", { name: "Sort by Asset" });
    expect(assetHeaderBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    let rows = screen.getAllByRole("button", { name: /open .* depeg detail/i });
    expect(within(rows[0]).getByText("LIVE")).toBeTruthy();

    fireEvent.click(assetHeaderBtn);

    expect(assetHeaderBtn.closest("th")?.getAttribute("aria-sort")).toBe("ascending");
    rows = screen.getAllByRole("button", { name: /open .* depeg detail/i });
    expect(within(rows[0]).getByText("CLEAR")).toBeTruthy();
  });

  it("filters rows by Status segmented control (All | Active/Pending | DEWS Alert+ | At peg) without misclassifying unknown deviations", () => {
    const active = makeRow({ id: "active", symbol: "ACT", activeDepeg: true, currentDeviationBps: -400 }, makeDews({ score: 20, band: "WATCH" }));
    const pending = makeRow({ id: "pending", symbol: "PND", activeDepeg: false, currentDeviationBps: -130 }, makeDews({ score: 15, band: "WATCH" }));
    pending.pendingIncident = makePendingIncident({ stablecoinId: "pending", symbol: "PND" });
    const alertOnly = makeRow({ id: "alert", symbol: "ALRT", activeDepeg: false, currentDeviationBps: -20 }, makeDews({ score: 50, band: "ALERT" }));
    const atPeg = makeRow({ id: "calm", symbol: "CALM", activeDepeg: false, currentDeviationBps: 5 }, makeDews({ score: 5, band: "CALM" }));
    const unknown = makeRow({ id: "unk", symbol: "UNK", activeDepeg: false, currentDeviationBps: null }, makeDews({ score: 0, band: "CALM" }));

    renderBoard([active, pending, alertOnly, atPeg, unknown]);

    const statusGroup = screen.getByRole("group", { name: "Filter by peg status" });
    const visibleSymbols = () =>
      screen.getAllByRole("button", { name: /open .* depeg detail/i }).map((el) => el.getAttribute("aria-label"));

    expect(visibleSymbols()).toHaveLength(5);

    fireEvent.click(within(statusGroup).getByRole("button", { name: "Active/Pending" }));
    expect(visibleSymbols()).toEqual(["Open ACT depeg detail", "Open PND depeg detail"]);

    fireEvent.click(within(statusGroup).getByRole("button", { name: "DEWS Alert+" }));
    expect(visibleSymbols()).toEqual(["Open ALRT depeg detail"]);

    fireEvent.click(within(statusGroup).getByRole("button", { name: "At peg" }));
    // ALRT (-20 bps) and CALM (5 bps) are observed within peg; UNK (null deviation) is never claimed at peg.
    expect(visibleSymbols()).toEqual(["Open ALRT depeg detail", "Open CALM depeg detail"]);

    fireEvent.click(within(statusGroup).getByRole("button", { name: "All" }));
    expect(visibleSymbols()).toHaveLength(5);
  });

  it("counts below-floor rows in the same filtered universe as the attention figure", () => {
    const goldFloor = makeRow({
      id: "gold-floor",
      symbol: "GOLDF",
      pegCurrency: "GOLD",
      depegEventCoverageLimited: true,
      activeDepeg: false,
      currentDeviationBps: 0,
    }, null);

    renderBoard([goldFloor], { pegFilter: "GOLD" });

    expect(screen.getByText(/need attention/).textContent).toBe(
      "0 filtered coins need attention · 1 below the event-history floor",
    );
  });

});
