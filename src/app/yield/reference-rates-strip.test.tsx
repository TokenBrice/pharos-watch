// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReferenceRatesStrip } from "@/app/yield/reference-rates-strip";
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
    fetchedAt: 1_776_000_000,
    ageSeconds: 60,
    source: `${key.toLowerCase()}-source`,
    isFallback: false,
    fallbackMode: null,
  };
}

const benchmarks: YieldBenchmarkRegistry = {
  USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-18"),
  EUR: makeBenchmark("EUR", "EUR", "EUR 3M compounded €STR", 1.94, "2026-05-19"),
  CHF: makeBenchmark("CHF", "CHF", "CHF 3M compounded SARON", -0.05, "2026-05-15"),
  AUD: makeBenchmark("AUD", "AUD", "AUD cash-rate target", 4.35, "2026-06-04"),
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
  afterEach(() => {
    cleanup();
  });

  it("renders the kicker, headline, lede, comparative table headers, and freshness footer", () => {
    render(
      <ReferenceRatesStrip benchmarks={benchmarks} poolInputMeta={poolInputMeta} safetySnapshot={safetySnapshot} />,
    );

    expect(screen.getByText("Reference rates")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Risk-free benchmark per currency/i })).toBeTruthy();
    expect(
      screen.getByText(/Each yield in the leaderboard is graded against the local risk-free benchmark/i),
    ).toBeTruthy();

    const tableShell = screen.getByTestId("yield-reference-rates-table");
    expect(tableShell.getAttribute("data-table-id")).toBe("yield-reference-rates");

    const table = screen.getByRole("table", { name: "Per-currency reference rates" });
    expect(within(table).getByRole("columnheader", { name: "Currency" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Rate" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "vs USD" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Benchmark" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "As of" })).toBeTruthy();

    expect(screen.getByText("Data freshness")).toBeTruthy();
    expect(screen.getByText(/Pool input age 4m/i)).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
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
    expect(within(usdRow).getByText("2026-05-18")).toBeTruthy();

    const eurRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("EUR"));
    expect(within(eurRow!).getByText("€")).toBeTruthy();
  });

  it("renders the fallback provenance benchmark when the optional registry is absent", () => {
    render(
      <ReferenceRatesStrip
        benchmarks={null}
        fallbackBenchmark={makeBenchmark("USD", "USD", "USD 3M T-Bill", 4.25, "2026-06-18")}
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

  it("renders the Tracked column with per-currency counts when currencyCounts is provided", () => {
    render(<ReferenceRatesStrip benchmarks={benchmarks} currencyCounts={{ USD: 25, EUR: 8, CHF: 1, AUD: 2 }} />);

    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Tracked" })).toBeTruthy();

    const usdRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("USD"));
    expect(within(usdRow!).getByText("25")).toBeTruthy();
    const eurRow = within(table)
      .getAllByRole("row")
      .find((r) => within(r).queryByText("EUR"));
    expect(within(eurRow!).getByText("8")).toBeTruthy();
  });

  it("hides the Tracked column when no currencyCounts prop is provided", () => {
    render(<ReferenceRatesStrip benchmarks={benchmarks} />);
    expect(screen.queryByRole("columnheader", { name: "Tracked" })).toBeNull();
  });

  it("renders an SVG flag for known currencies and an ISO fallback for unknown ones", () => {
    const unknownBenchmarks: YieldBenchmarkRegistry = {
      USD: makeBenchmark("USD", "USD", "USD 3M T-Bill", 3.68, "2026-05-18"),
      USD_EFFR: makeBenchmark("XYZ", "USD_EFFR", "XYZ test benchmark", 1.0, "2026-05-01"),
    };

    render(<ReferenceRatesStrip benchmarks={unknownBenchmarks} />);

    const table = screen.getByRole("table");
    const svgs = table.querySelectorAll("svg");
    expect(svgs.length).toBe(1); // only USD has a flag SVG
    expect(within(table).getByText("XY")).toBeTruthy(); // fallback shows first two chars
  });

  it("returns nothing when there are no inputs to display", () => {
    const { container } = render(<ReferenceRatesStrip benchmarks={null} poolInputMeta={null} safetySnapshot={null} />);
    expect(container.textContent).toBe("");
  });

  it("tints the pool input age amber when the input is stale", () => {
    const staleMeta: YieldSourceInputMeta = {
      ...poolInputMeta,
      ageSeconds: 90 * 60,
    };

    render(<ReferenceRatesStrip benchmarks={null} poolInputMeta={staleMeta} safetySnapshot={null} />);

    const chip = screen.getByText(/Pool input age 90m/i);
    expect(chip.className).toContain("amber");
  });

  it("does not render the freshness footer when no source meta is provided", () => {
    render(<ReferenceRatesStrip benchmarks={benchmarks} poolInputMeta={null} safetySnapshot={null} />);
    expect(screen.queryByText("Data freshness")).toBeNull();
  });
});
