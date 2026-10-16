// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReferenceRatesStrip } from "@/components/yield/reference-rates-strip";
import type {
  YieldBenchmarkMeta,
  YieldBenchmarkRegistry,
  YieldSafetySnapshotMeta,
  YieldSourceInputMeta,
} from "@shared/types";

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
    vi.useFakeTimers({ now: FAKE_NOW });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

  it("tints a benchmark row amber with a reason and an age marker when its record is stale", () => {
    const staleRegistry: YieldBenchmarkRegistry = {
      USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-19"),
      // Exactly 42 days before the pinned clock.
      CAD: makeBenchmark("CAD", "CAD", "CAD Bank of Canada Bank Rate", 2.75, "2026-04-08"),
    };

    render(<ReferenceRatesStrip benchmarks={staleRegistry} />);

    const table = screen.getByRole("table");
    const cadRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("CAD"));
    expect(cadRow).toBeDefined();

    // The stale observation is visibly marked while a freshly fetched record is not.
    const dateChip = within(cadRow!).getByText("2026-04-08");
    expect(dateChip.className).toContain("state-warn");
    expect(within(cadRow!).getByLabelText(/observation.*freshness/i)).toBe(dateChip);

    // Age marker appended through the shared benchmark suffix.
    expect(within(cadRow!).getByText(/42d old/)).toBeTruthy();

    // A fresh row stays untinted and unmarked.
    const usdRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("USD"));
    expect(within(usdRow!).getByText("2026-05-19").className).not.toContain("state-warn");
    expect(within(usdRow!).queryByText(/old/)).toBeNull();
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
