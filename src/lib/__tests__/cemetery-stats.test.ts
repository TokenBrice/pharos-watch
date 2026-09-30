import { describe, expect, it } from "vitest";
import { CAUSE_ORDER, type CauseOfDeath } from "@shared/lib/cause-of-death";
import { formatPercentFromRatio } from "@shared/lib/format";
import {
  buildCemeteryFaq,
  buildCemeteryStats,
  formatCemeteryPeak,
  type CemeteryPatternKey,
  type CemeteryStats,
  type CemeteryStatsInput,
} from "@/lib/cemetery-stats";

let seq = 0;
function row(
  causeOfDeath: CauseOfDeath,
  deathDate: string,
  overrides: Partial<CemeteryStatsInput> = {},
): CemeteryStatsInput {
  seq += 1;
  const id = overrides.id ?? `coin-${seq}`;
  return {
    id,
    name: `Coin ${id}`,
    symbol: id.toUpperCase(),
    causeOfDeath,
    deathDate,
    pegCurrency: "USD",
    peakMcap: 10_000_000,
    ...overrides,
  };
}

function rows(count: number, causeOfDeath: CauseOfDeath, deathDate: string, overrides: Partial<CemeteryStatsInput> = {}) {
  return Array.from({ length: count }, () => row(causeOfDeath, deathDate, overrides));
}

function patternKeys(stats: CemeteryStats): CemeteryPatternKey[] {
  return stats.patterns.map((p) => p.key);
}

const tracked = { archivedDataAvailable: true } as const;

describe("buildCemeteryStats: recorded peaks", () => {
  const stats = buildCemeteryStats([
    row("abandoned", "2023-01", { peakMcap: 100 }),
    row("abandoned", "2023-02", { peakMcap: null }),
    row("abandoned", "2023-03", { peakMcap: undefined }),
    row("abandoned", "2023-04", { peakMcap: 0 }),
    row("abandoned", "2023-05", { peakMcap: Number.NaN }),
    row("abandoned", "2023-06", { peakMcap: -5 }),
    row("regulatory", "2023-07", { peakMcap: 300 }),
    row("liquidity-drain", "2023-08", { peakMcap: 200 }),
  ]);

  it("excludes null, undefined, zero, NaN and negative peaks from sums and counts them as unrecorded", () => {
    expect(stats.peak).toMatchObject({ recordedTotal: 600, knownCount: 3, unrecordedCount: 5, median: 200 });
    const abandoned = stats.causes.find((c) => c.cause === "abandoned");
    expect(abandoned).toMatchObject({ count: 6, knownCount: 1, unrecordedCount: 5, recordedPeakSum: 100, medianPeak: 100 });
    expect(abandoned?.peakShare).toBeCloseTo(100 / 600);
    expect(stats.peakBuckets.find((b) => b.key === "not-recorded")?.count).toBe(5);
    expect(stats.peakByCause.unplottedCount).toBe(5);
    expect(stats.peakByCause.lanes.find((l) => l.cause === "abandoned")).toMatchObject({ n: 1, unrecordedCount: 5 });
  });

  it("reports a cause with no recorded peak as null, never 0", () => {
    const counterparty = stats.causes.find((c) => c.cause === "counterparty-failure");
    expect(counterparty).toMatchObject({ count: 0, recordedPeakSum: null, peakShare: null, medianPeak: null, largest: null });
    const onlyUnrecorded = buildCemeteryStats([row("algorithmic-failure", "2018-03", { peakMcap: undefined })]);
    expect(onlyUnrecorded.peak).toMatchObject({ recordedTotal: null, median: null, knownCount: 0 });
    expect(onlyUnrecorded.years[0]).toMatchObject({ total: 1, medianPeak: null, recordedPeakSum: null, recordedPeakCount: 0 });
    expect(onlyUnrecorded.keyFacts.topTwo).toBeNull();
  });

  it("averages the two middle values for an even-sized median", () => {
    const even = buildCemeteryStats([
      row("abandoned", "2024-01", { peakMcap: 10 }),
      row("abandoned", "2024-01", { peakMcap: 30 }),
      row("abandoned", "2024-01", { peakMcap: null }),
    ]);
    expect(even.keyFacts.medianPeak).toEqual({ value: 20, knownCount: 2 });
  });
});

describe("buildCemeteryStats: as-of anchoring", () => {
  it("anchors on the latest deathDate and prefers the day-precise date within the same month", () => {
    const stats = buildCemeteryStats([
      row("abandoned", "2025-03"),
      row("abandoned", "2025-03-14"),
      row("abandoned", "2024-11-02"),
    ]);
    expect(stats.asOf).toMatchObject({ date: "2025-03-14", year: 2025, month: 3, day: 14, precision: "day", label: "Mar 14, 2025" });
  });

  it("reports month precision when the latest record is month-precise", () => {
    const stats = buildCemeteryStats([row("abandoned", "2025-03-14"), row("abandoned", "2025-04")]);
    expect(stats.asOf).toMatchObject({ date: "2025-04", month: 4, day: null, precision: "month", label: "Apr 2025" });
  });

  it("marks only the as-of year partial when the data stops before December", () => {
    const partial = buildCemeteryStats([row("abandoned", "2023-12"), row("abandoned", "2024-08")]);
    expect(partial.years.map((y) => [y.year, y.partial])).toEqual([[2023, false], [2024, true]]);

    const complete = buildCemeteryStats([row("abandoned", "2023-05"), row("abandoned", "2024-12")]);
    expect(complete.years.at(-1)?.partial).toBe(false);
  });

  it("keeps every year between the first and latest record, empty years at total 0 with null medians", () => {
    const stats = buildCemeteryStats([row("algorithmic-failure", "2018-03"), row("abandoned", "2021-06", tracked)]);
    expect(stats.years.map((y) => y.year)).toEqual([2018, 2019, 2020, 2021]);
    expect(stats.years[1]).toMatchObject({ total: 0, tracked: 0, curated: 0, medianPeak: null, recordedPeakCount: 0 });
    expect(stats.years[3]).toMatchObject({ total: 1, tracked: 1, curated: 0 });
    expect(stats.firstYear).toBe(2018);
    expect(stats.latestYear).toBe(2021);
    expect(stats.heroSubline).toBe("2018–2021 · each with cause, date, obituary and source");
  });

  it("splits each year's tracked-archive records by cause", () => {
    const stats = buildCemeteryStats([
      row("abandoned", "2025-02", tracked),
      row("abandoned", "2025-03"),
      row("counterparty-failure", "2025-04", tracked),
      row("counterparty-failure", "2025-05", tracked),
      row("regulatory", "2025-06"),
    ]);
    const [year] = stats.years;
    expect(year.trackedByCause).toEqual({
      abandoned: 1,
      "counterparty-failure": 2,
      "liquidity-drain": 0,
      "algorithmic-failure": 0,
      regulatory: 0,
    });
    expect(year.tracked).toBe(3);
  });

  it("derives updatedAt from the latest recordedAt, or null when none is recorded", () => {
    expect(buildCemeteryStats([row("abandoned", "2024-01")]).updatedAt).toBeNull();
    const stats = buildCemeteryStats([
      row("abandoned", "2024-01", { recordedAt: "2025-02-01" }),
      row("abandoned", "2024-02", { recordedAt: "2026-01-15" }),
      row("abandoned", "2024-03"),
    ]);
    expect(stats.updatedAt).toBe("2026-01-15");
  });

  it("counts day-precise and month-precise death dates across the full set", () => {
    const stats = buildCemeteryStats([
      row("abandoned", "2024-01"),
      row("abandoned", "2024-02-10", tracked),
      row("abandoned", "2024-03"),
      row("regulatory", "2023-07-31"),
    ]);
    expect(stats.datePrecision).toEqual({ day: 2, month: 2 });
  });

  it("rejects a malformed deathDate instead of miscounting it", () => {
    expect(() => buildCemeteryStats([row("abandoned", "2024-13")])).toThrow(/invalid deathDate/);
  });
});

describe("buildCemeteryStats: trailing windows", () => {
  it("counts 12 calendar months ending at the as-of month against the 12 before, split tracked vs curated", () => {
    const stats = buildCemeteryStats([
      row("abandoned", "2026-08-27", tracked),
      row("abandoned", "2025-09"),
      row("abandoned", "2025-08", tracked),
      row("abandoned", "2024-09"),
      row("abandoned", "2024-08"),
    ]);
    expect(stats.keyFacts.trailing12).toEqual({ startMonth: "2025-09", endMonth: "2026-08", months: 12, total: 2, tracked: 1, curated: 1 });
    expect(stats.keyFacts.prior12).toEqual({ startMonth: "2024-09", endMonth: "2025-08", months: 12, total: 2, tracked: 1, curated: 1 });
    expect(stats.trackedCount).toBe(2);
    expect(stats.curatedCount).toBe(3);
    expect(stats.keyFacts.trackedCount).toBe(2);
  });
});

describe("pattern: deaths-more-frequent (curated-only guard)", () => {
  it("is omitted when the rise comes from tracked-archive rows while curated records stay flat", () => {
    const stats = buildCemeteryStats([
      ...rows(5, "abandoned", "2026-03"),
      ...rows(10, "abandoned", "2026-04", tracked),
      ...rows(5, "abandoned", "2025-03"),
    ]);
    expect(stats.keyFacts.trailing12.total).toBe(15);
    expect(stats.keyFacts.prior12.total).toBe(5);
    expect(stats.keyFacts.curatedTrend).toEqual({ trailing: 5, prior: 5, direction: "flat" });
    expect(patternKeys(stats)).not.toContain("deaths-more-frequent");

    const trend = buildCemeteryFaq(stats).find((item) => item.question === "Are stablecoin deaths becoming more common?");
    expect(trend?.answer).toContain("Not demonstrably.");
    expect(trend?.answer).toContain("Curated records were flat at 5 against 5");
    expect(trend?.answer).toContain("tracked archive (10 against 0)");
  });

  it("is omitted when the curated rise clears 25% but not 5 records", () => {
    const stats = buildCemeteryStats([...rows(6, "abandoned", "2026-03"), ...rows(4, "abandoned", "2025-03")]);
    expect(stats.keyFacts.curatedTrend.direction).toBe("flat");
    expect(patternKeys(stats)).not.toContain("deaths-more-frequent");
  });

  it("is omitted when the curated rise clears 5 records but not 25%", () => {
    const stats = buildCemeteryStats([...rows(26, "abandoned", "2026-03"), ...rows(21, "abandoned", "2025-03")]);
    expect(stats.keyFacts.curatedTrend.direction).toBe("flat");
    expect(patternKeys(stats)).not.toContain("deaths-more-frequent");
  });

  it("is present when curated records alone rise by at least 25% and 5 records", () => {
    const stats = buildCemeteryStats([...rows(10, "abandoned", "2026-03"), ...rows(4, "abandoned", "2025-03")]);
    expect(stats.keyFacts.curatedTrend).toEqual({ trailing: 10, prior: 4, direction: "rising" });
    const pattern = stats.patterns.find((p) => p.key === "deaths-more-frequent");
    expect(pattern?.body).toContain("Curated records alone rose from 4 to 10");
    expect(pattern?.registerFilter).toEqual({ record: "curated" });
    const trend = buildCemeteryFaq(stats).find((item) => item.question === "Are stablecoin deaths becoming more common?");
    expect(trend?.answer).not.toContain("Not demonstrably");
  });
});

describe("pattern: algorithmic-early", () => {
  it("is present when algorithmic records dominate through 2022 and are rare since, on the full and curated sets", () => {
    const stats = buildCemeteryStats([
      ...rows(3, "algorithmic-failure", "2022-05"),
      row("abandoned", "2022-06"),
      row("algorithmic-failure", "2024-01"),
      ...rows(9, "abandoned", "2024-02"),
    ]);
    expect(stats.algorithmicEra).toMatchObject({ through: { count: 3, total: 4 }, since: { count: 1, total: 10 } });
    const pattern = stats.patterns.find((p) => p.key === "algorithmic-early");
    expect(pattern?.body).toBe("Algorithmic failures made up 3 of the 4 records through 2022, and 1 of the 10 since.");
    expect(pattern?.registerFilter).toEqual({ cause: "algorithmic-failure" });
  });

  it("is omitted when algorithmic records are under half of the early record", () => {
    const stats = buildCemeteryStats([
      row("algorithmic-failure", "2022-05"),
      ...rows(2, "abandoned", "2022-06"),
      ...rows(10, "abandoned", "2024-02"),
    ]);
    expect(patternKeys(stats)).not.toContain("algorithmic-early");
  });

  it("is omitted when algorithmic records exceed 10% since 2023", () => {
    const stats = buildCemeteryStats([
      ...rows(3, "algorithmic-failure", "2022-05"),
      ...rows(2, "algorithmic-failure", "2024-01"),
      ...rows(8, "abandoned", "2024-02"),
    ]);
    expect(patternKeys(stats)).not.toContain("algorithmic-early");
  });

  it("is omitted when only tracked-archive rows dilute the recent algorithmic share below 10%", () => {
    const stats = buildCemeteryStats([
      ...rows(3, "algorithmic-failure", "2022-05"),
      ...rows(2, "algorithmic-failure", "2024-01"),
      ...rows(8, "abandoned", "2024-02"),
      ...rows(20, "abandoned", "2025-02", tracked),
    ]);
    expect(stats.algorithmicEra.since).toEqual({ count: 2, total: 30 });
    expect(stats.algorithmicEra.curatedSince).toEqual({ count: 2, total: 10 });
    expect(patternKeys(stats)).not.toContain("algorithmic-early");
  });
});

describe("pattern: abandoned-most-common", () => {
  it("is present when abandoned is the strict count argmax", () => {
    const stats = buildCemeteryStats([
      ...rows(3, "abandoned", "2024-01", { peakMcap: 40 }),
      ...rows(2, "regulatory", "2024-02"),
    ]);
    const pattern = stats.patterns.find((p) => p.key === "abandoned-most-common");
    expect(pattern?.body).toBe(
      `3 of 5 records (60%) ended with the issuer or protocol no longer maintaining the coin. Their median recorded peak market cap was ${formatCemeteryPeak(40)}.`,
    );
    expect(pattern?.registerFilter).toEqual({ cause: "abandoned" });
  });

  it("is omitted on a tie or when another cause leads", () => {
    const tie = buildCemeteryStats([...rows(2, "abandoned", "2024-01"), ...rows(2, "liquidity-drain", "2024-02")]);
    expect(patternKeys(tie)).not.toContain("abandoned-most-common");
    const other = buildCemeteryStats([row("abandoned", "2024-01"), ...rows(2, "liquidity-drain", "2024-02")]);
    expect(patternKeys(other)).not.toContain("abandoned-most-common");
  });
});

describe("pattern: counterparty-rising (curated-only)", () => {
  it("is present when the curated counterparty share since January of last year exceeds the two prior years", () => {
    const stats = buildCemeteryStats([
      ...rows(3, "counterparty-failure", "2025-06"),
      ...rows(3, "abandoned", "2026-04"),
      row("counterparty-failure", "2023-06"),
      ...rows(7, "abandoned", "2024-06"),
      row("abandoned", "2022-01"),
    ]);
    expect(stats.counterpartyRecent).toEqual({
      recentFromYear: 2025,
      priorYears: [2023, 2024],
      curatedRecent: { count: 3, total: 6 },
      curatedPrior: { count: 1, total: 8 },
    });
    const pattern = stats.patterns.find((p) => p.key === "counterparty-rising");
    expect(pattern?.body).toBe(
      "Among curated records, counterparty failures were 3 of 6 since January 2025 (50%), against 1 of 8 in 2023 and 2024 (13%).",
    );
    expect(pattern?.registerFilter).toEqual({ cause: "counterparty-failure", record: "curated" });
  });

  it("is omitted when only tracked-archive counterparty rows make the recent share rise", () => {
    const stats = buildCemeteryStats([
      row("counterparty-failure", "2025-06"),
      ...rows(7, "abandoned", "2026-04"),
      ...rows(10, "counterparty-failure", "2026-05", tracked),
      row("counterparty-failure", "2023-06"),
      ...rows(7, "abandoned", "2024-06"),
    ]);
    expect(stats.counterpartyRecent.curatedRecent).toEqual({ count: 1, total: 8 });
    expect(patternKeys(stats)).not.toContain("counterparty-rising");
  });
});

describe("pattern: top-two-concentration", () => {
  it("reports the top-two share of the recorded peak with knownCount", () => {
    const stats = buildCemeteryStats([
      row("regulatory", "2023-02", { id: "big", peakMcap: 600 }),
      row("algorithmic-failure", "2022-05", { id: "second", peakMcap: 300 }),
      row("abandoned", "2024-01", { peakMcap: 100 }),
      row("abandoned", "2024-02", { peakMcap: null }),
    ]);
    expect(stats.keyFacts.topTwo).toMatchObject({
      ids: ["big", "second"],
      symbols: ["BIG", "SECOND"],
      peaks: [600, 300],
      sum: 900,
      recordedTotal: 1000,
      knownCount: 3,
      total: 4,
    });
    expect(stats.keyFacts.topTwo?.share).toBeCloseTo(0.9);
    const pattern = stats.patterns.find((p) => p.key === "top-two-concentration");
    expect(pattern?.body).toContain(`account for ${formatPercentFromRatio(0.9, 1)} of the ${formatCemeteryPeak(1000)} combined peak market cap, recorded for 3 of 4 records.`);
    expect(pattern?.registerFilter).toEqual({ sort: "peak", dir: "desc" });
  });

  it("is omitted when the top two hold half or less of the recorded peak", () => {
    const stats = buildCemeteryStats([
      row("abandoned", "2024-01", { peakMcap: 25 }),
      row("abandoned", "2024-02", { peakMcap: 25 }),
      row("abandoned", "2024-03", { peakMcap: 25 }),
      row("abandoned", "2024-04", { peakMcap: 25 }),
    ]);
    expect(stats.keyFacts.topTwo?.share).toBe(0.5);
    expect(patternKeys(stats)).not.toContain("top-two-concentration");
  });
});

describe("pattern: largest-not-collapse", () => {
  it("names the largest peak when a discontinued cause holds it, and the largest collapse", () => {
    const stats = buildCemeteryStats([
      row("regulatory", "2023-02", { id: "ended", peakMcap: 600 }),
      row("algorithmic-failure", "2022-05", { id: "crashed", peakMcap: 300 }),
      row("abandoned", "2024-01", { peakMcap: 100 }),
    ]);
    const pattern = stats.patterns.find((p) => p.key === "largest-not-collapse");
    expect(pattern?.headline).toBe("The largest coins did not all collapse");
    expect(pattern?.body).toBe(
      `The largest recorded peak, ENDED (${formatCemeteryPeak(600)}), was ended by a regulator or licensing regime; the largest collapse was CRASHED (${formatCemeteryPeak(300)}).`,
    );
  });

  it("is omitted when a collapse holds the largest peak or no collapse has a recorded peak", () => {
    const collapseLargest = buildCemeteryStats([
      row("regulatory", "2023-02", { peakMcap: 300 }),
      row("liquidity-drain", "2022-05", { peakMcap: 600 }),
    ]);
    expect(patternKeys(collapseLargest)).not.toContain("largest-not-collapse");
    const noCollapsePeak = buildCemeteryStats([
      row("abandoned", "2023-02", { peakMcap: 300 }),
      row("counterparty-failure", "2022-05", { peakMcap: null }),
    ]);
    expect(patternKeys(noCollapsePeak)).not.toContain("largest-not-collapse");
  });
});

describe("buildCemeteryStats: ordering and series", () => {
  const stats = buildCemeteryStats([
    row("regulatory", "2023-02", { id: "r1", peakMcap: 7000 }),
    row("abandoned", "2022-08", { id: "a1", peakMcap: 5000 }),
    row("abandoned", "2023-08", { id: "a2", peakMcap: 1 }),
    row("liquidity-drain", "2026-07", { id: "l1", peakMcap: 3000 }),
    row("algorithmic-failure", "2022-05", { id: "g1", peakMcap: 6000 }),
    row("counterparty-failure", "2025-01", { id: "c1", peakMcap: 2000 }),
    row("counterparty-failure", "2025-02", { id: "c2", peakMcap: 1000 }),
    row("counterparty-failure", "2025-03", { id: "c3", peakMcap: null }),
  ]);

  it("follows CAUSE_ORDER for causes, lanes and per-year cause counts", () => {
    expect(stats.causes.map((c) => c.cause)).toEqual([...CAUSE_ORDER]);
    expect(stats.peakByCause.lanes.map((l) => l.cause)).toEqual([...CAUSE_ORDER]);
    expect(Object.keys(stats.years[0].byCause)).toEqual([...CAUSE_ORDER]);
  });

  it("labels the global top five by peak and orders lane dots by peak descending", () => {
    expect(stats.peakByCause.labelledIds).toEqual(["r1", "g1", "a1", "l1", "c1"]);
    const counterparty = stats.peakByCause.lanes.find((l) => l.cause === "counterparty-failure");
    expect(counterparty?.dots.map((d) => [d.id, d.labelled])).toEqual([["c1", true], ["c2", false]]);
    expect(counterparty?.unrecordedCount).toBe(1);
    expect(stats.peakByCause.extent).toEqual({ min: 1, max: 7000 });
  });

  it("names the largest record per cause", () => {
    expect(stats.causes.find((c) => c.cause === "abandoned")?.largest).toMatchObject({ id: "a1", peak: 5000 });
  });

  it("counts mechanism archetypes and treats missing or unknown values as unmapped", () => {
    const mech = buildCemeteryStats([
      row("abandoned", "2024-01", { mechanismArchetype: "cdp" }),
      row("abandoned", "2024-02", { mechanismArchetype: "cdp" }),
      row("abandoned", "2024-03", { mechanismArchetype: "algorithmic" }),
      row("abandoned", "2024-04", { mechanismArchetype: null }),
      row("abandoned", "2024-05", { mechanismArchetype: "not-an-archetype" }),
      row("abandoned", "2024-06"),
    ]).mechanisms;
    expect(mech.counts.find((c) => c.archetype === "cdp")?.count).toBe(2);
    expect(mech.counts.find((c) => c.archetype === "algorithmic")?.count).toBe(1);
    expect(mech.mappedCount).toBe(3);
    expect(mech.unmappedCount).toBe(3);
  });
});

describe("buildCemeteryFaq", () => {
  const stats = buildCemeteryStats([
    row("regulatory", "2023-02", { id: "reg", name: "Regulated Dollar", peakMcap: 20_000_000_000 }),
    row("abandoned", "2023-05", { id: "aband", peakMcap: 15_000_000_000 }),
    row("algorithmic-failure", "2022-05", { id: "algo", name: "Algo Dollar", peakMcap: 10_000_000_000 }),
    row("liquidity-drain", "2024-06", { id: "drain", peakMcap: 5_000_000_000 }),
    row("counterparty-failure", "2025-09-12", { id: "cp", peakMcap: null, archivedDataAvailable: true }),
  ]);
  const faq = buildCemeteryFaq(stats);
  const answer = (question: string) => faq.find((item) => item.question === question)?.answer ?? "";

  it("returns 7 to 8 questions", () => {
    expect(faq.length).toBeGreaterThanOrEqual(7);
    expect(faq.length).toBeLessThanOrEqual(8);
  });

  it("splits the largest collapse (non-regulatory, non-abandoned) from the largest discontinued coin", () => {
    const collapse = answer("What was the largest collapse?");
    expect(collapse).toContain("Algo Dollar (ALGO)");
    expect(collapse).toContain(formatCemeteryPeak(10_000_000_000));
    expect(collapse).toContain("May 2022");
    expect(collapse).not.toContain("REG");

    const discontinued = answer("What was the largest discontinued stablecoin?");
    expect(discontinued).toContain("Regulated Dollar (REG)");
    expect(discontinued).toContain(formatCemeteryPeak(20_000_000_000));
    expect(discontinued).toContain("a regulator or licensing regime");
    expect(discontinued).not.toMatch(/fail|collapse/i);
  });

  it("prints no number that cannot be derived from the stats", () => {
    const numbers: number[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === "number") numbers.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(stats);
    const allowed = numbers.flatMap((n) => [String(n), formatCemeteryPeak(n)]);
    for (const { answer: text } of faq) {
      for (const token of text.match(/\$?\d[\d.,]*[KMBT]?/g) ?? []) {
        expect(allowed, `unexpected figure "${token}" in: ${text}`).toContain(token.replace(/[.,]$/, ""));
      }
    }
  });

  it("never pairs a peak total with loss language", () => {
    for (const { answer: text } of faq) expect(text).not.toMatch(/destroyed|wiped|buried/i);
  });
});
