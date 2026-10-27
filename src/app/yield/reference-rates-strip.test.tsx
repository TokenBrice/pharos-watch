// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReferenceRatesStrip } from "@/components/yield/reference-rates-strip";
import type {
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types";

// Every test pins fake timers, so hydration's animation frames would never settle.
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));

function makeBenchmark(
  currency: string,
  key: NonNullable<YieldBenchmarkMeta["key"]>,
  label: string,
  rate: number,
  recordDate: string,
): YieldBenchmarkMeta {
  return {
    key,
    label,
    currency,
    rate,
    recordDate,
    fetchedAt: FAKE_NOW / 1000 - 60,
    ageSeconds: 60,
    source: `${key.toLowerCase()}-source`,
    isFallback: false,
    fallbackMode: null,
  };
}

// Age markers and amber tints resolve against the wall clock; pin it so the
// fixture rows are deterministically fresh (1d old against the 5d default
// bound) and the stale-CAD case is deterministically 42 days old.
const FAKE_NOW = Date.parse("2026-05-20T00:00:00Z");

const benchmarks: YieldBenchmarkRegistry = {
  USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-19"),
  EUR: makeBenchmark("EUR", "EUR", "EUR 3M compounded €STR", 1.94, "2026-05-19"),
  CHF: makeBenchmark("CHF", "CHF", "CHF 3M compounded SARON", -0.05, "2026-05-19"),
  AUD: makeBenchmark("AUD", "AUD", "AUD cash-rate target", 4.35, "2026-05-19"),
};

const poolInputMeta: YieldSourceInputMeta = {
  mode: "dex-cache",
  updatedAt: 1_776_000_000,
  ageSeconds: 240,
  poolCount: 142,
  fallbackMode: null,
};

const safetySnapshot: YieldSafetySnapshotMeta = {
  kind: "ok",
  coverageRatio: 0.91,
  coveredCount: 356,
  trackedCount: 392,
  reason: null,
};

describe("ReferenceRatesStrip", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.useFakeTimers({ now: FAKE_NOW });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    [7_201, false],
    [43_200, false],
    [43_201, true],
    [null, false],
  ] as const)("tints pool input only beyond the public stale band (age=%s)", (ageSeconds, stale) => {
    render(<ReferenceRatesStrip poolInputMeta={{ ...poolInputMeta, ageSeconds, updatedAt: ageSeconds === null ? null : FAKE_NOW / 1000 - ageSeconds }} />);
    const age = screen.getByText(ageSeconds === null ? "Pool input age unavailable" : /Pool input age \d+m/);
    if (ageSeconds === 7_201) expect(age.textContent).toBe("Pool input age 120m");
    expect(age.className.includes("state-warn")).toBe(stale);
    fireEvent.focus(age);
    expect(screen.getByRole("tooltip").textContent).toBe("DEX-sync cached DeFiLlama pools.");
  });

  it("tints pool input at its public crossing without a new payload", async () => {
    render(<ReferenceRatesStrip poolInputMeta={{ ...poolInputMeta, ageSeconds: 240, updatedAt: FAKE_NOW / 1000 - 43_199 }} />);
    const age = screen.getByText("Pool input age 4m");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(age.className).not.toContain("state-warn");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(age.className).toContain("state-warn");
  });

  it("renders unavailable Safety coverage without inventing a percentage", () => {
    render(<ReferenceRatesStrip safetySnapshot={{
      ...safetySnapshot,
      kind: "degraded",
      coverageRatio: null,
      trackedCount: null,
      coveredCount: 0,
      reason: "safety-score-publication-missing",
    }} />);

    const unavailable = screen.getByText("Safety coverage unavailable");
    expect(screen.getByText("Data freshness")).toBeTruthy();
    expect(screen.queryByText(/^(0|100)%$/)).toBeNull();
    fireEvent.focus(unavailable);
    expect(screen.getByRole("tooltip").textContent).toBe("safety-score-publication-missing");
  });

  it("keeps measured zero Safety coverage distinct from unavailable", () => {
    render(<ReferenceRatesStrip safetySnapshot={{
      ...safetySnapshot,
      kind: "degraded",
      coverageRatio: 0,
      coveredCount: 0,
      reason: "safety-snapshot-coverage",
    }} />);

    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.queryByText("Safety coverage unavailable")).toBeNull();
  });

  it("retains measured coverage with neutral provenance for a held accepted Safety snapshot", () => {
    render(<ReferenceRatesStrip safetySnapshot={{
      ...safetySnapshot,
      kind: "degraded",
      reason: "safety-snapshot-held",
    }} />);

    const coverage = screen.getByText("91%");
    expect(screen.queryByText("Safety coverage unavailable")).toBeNull();
    fireEvent.focus(coverage.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("Confidence-weighted source arbitration coverage across tracked rows.");
    expect(screen.queryByText(/safety-snapshot-held|degraded/i)).toBeNull();
  });

  it("renders one row per benchmark with the currency code, symbol, rate, and stripped benchmark label", () => {
    render(<ReferenceRatesStrip benchmarks={benchmarks} />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows.length).toBe(5);

    const usdRow = rows[1]!;
    expect(within(usdRow).getByText("USD")).toBeTruthy();
    expect(within(usdRow).getByText("$")).toBeTruthy();
    expect(within(usdRow).getByText("3.68%")).toBeTruthy();
    expect(within(usdRow).getByText("3M T-Bill")).toBeTruthy();
    expect(within(usdRow).getByText("2026-05-19")).toBeTruthy();

    const eurRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("EUR"));
    expect(within(eurRow!).getByText("€")).toBeTruthy();
  });

  it.each([
    ["RUB", "₽"],
    ["CHF", "Fr"],
    ["MXN", "Mex$"],
  ] as const)("renders the shared glyph or deliberate override for %s", (currency, glyph) => {
    render(<ReferenceRatesStrip fallbackBenchmark={makeBenchmark(currency, currency, `${currency} reference`, 3, "2026-05-19")} />);
    const row = screen.getByText(currency).closest("tr")!;
    expect(within(row).getByText(glyph)).toBeTruthy();
  });

  it("renders the fallback provenance benchmark when the optional registry is absent", () => {
    render(
      <ReferenceRatesStrip
        benchmarks={null}
        fallbackBenchmark={makeBenchmark("USD", "USD", "USD 3M T-Bill", 4.25, "2026-05-19")}
        poolInputMeta={poolInputMeta}
        safetySnapshot={safetySnapshot}
      />,
    );

    const table = screen.getByRole("table", { name: "Per-currency reference rates" });
    expect(within(table).getByText("USD")).toBeTruthy();
    expect(within(table).getByText("4.25%")).toBeTruthy();
    expect(within(table).getByText("3M T-Bill")).toBeTruthy();
    expect(screen.getByText(/Pool input age 4m/i)).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
  });

  it("shows an em-dash for USD's spread and computes signed basis-point spreads for the others", () => {
    render(<ReferenceRatesStrip benchmarks={benchmarks} />);

    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    const usdCells = within(rows[1]!).getAllByRole("cell");
    expect(usdCells[3]!.textContent).toBe("—");

    // EUR rate 1.94 vs USD 3.68 → −174 bps
    const eurRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("EUR"));
    expect(eurRow).toBeDefined();
    expect(within(eurRow!).getByText("−174 bps")).toBeTruthy();

    // AUD rate 4.35 vs USD 3.68 -> +67 bps
    const audRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("AUD"));
    expect(audRow).toBeDefined();
    expect(within(audRow!).getByText("+67 bps")).toBeTruthy();
  });

  it("returns nothing when there are no inputs to display", () => {
    const { container } = render(<ReferenceRatesStrip benchmarks={null} poolInputMeta={null} safetySnapshot={null} />);
    expect(container.textContent).toBe("");
  });

  it("keeps record dates and fallback identity neutral and tints only an aged fetch generation", () => {
    const registry = {
      USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-19"),
      // 42 days old against the default daily bound: scoring-stale, not a reader warning.
      CAD: makeBenchmark("CAD", "CAD", "CAD Bank of Canada Bank Rate", 2.75, "2026-04-08"),
      EUR: { ...makeBenchmark("EUR", "EUR", "EUR 3M compounded €STR", 1.94, "2026-05-19"), isFallback: true, fallbackMode: "eur-retained" },
      // Fetched 13 days ago: past the daily producer's 12x public band.
      GBP: { ...makeBenchmark("GBP", "GBP", "GBP SONIA", 4.2, "2026-05-06"), fetchedAt: FAKE_NOW / 1000 - 13 * 86_400 },
      JPY: { ...makeBenchmark("JPY", "JPY", "JPY TONA", 0.5, "2026-05-19"), fetchedAt: null },
    } as YieldBenchmarkRegistry;

    render(<ReferenceRatesStrip benchmarks={registry} />);
    const rowFor = (currency: string) => screen.getByText(currency).closest("tr")!;

    for (const currency of ["USD", "CAD", "EUR"]) {
      const row = rowFor(currency);
      expect(row.innerHTML).not.toContain("state-warn");
      expect(row.textContent).not.toMatch(/old|unavailable|fallback/);
    }
    expect(within(rowFor("GBP")).getByText("2026-05-06").className).toContain("state-warn");
    expect(within(rowFor("GBP")).getByText(/13d old/)).toBeTruthy();
    expect(within(rowFor("JPY")).getByText("2026-05-19").className).toContain("state-warn");
    expect(within(rowFor("JPY")).getByText(/unavailable/)).toBeTruthy();
    expect(screen.queryByText(/not a healthy reference|freshness bound/)).toBeNull();
  });

  it("uses the payload's per-key record bound instead of the default when present", () => {
    const boundedRegistry = {
      USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-19"),
      // 42 days old but inside CAD's published 45-day monthly cadence.
      CAD: {
        ...makeBenchmark("CAD", "CAD", "CAD Bank of Canada Bank Rate", 2.75, "2026-04-08"),
        recordAgeSec: 42 * 24 * 60 * 60,
        maxRecordAgeSec: 45 * 24 * 60 * 60,
      } as YieldBenchmarkMeta,
    };

    render(<ReferenceRatesStrip benchmarks={boundedRegistry} />);

    const table = screen.getByRole("table");
    const cadRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("CAD"));
    expect(within(cadRow!).getByText("2026-04-08").className).not.toContain("state-warn");
    expect(within(cadRow!).queryByText(/old/)).toBeNull();
  });
});
