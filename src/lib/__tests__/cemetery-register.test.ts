import { describe, expect, it } from "vitest";
import { type CemeteryEntry } from "@shared/lib/cemetery-merged";

import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import { buildCemeteryRegisterRows, buildRegisterFilterOptions } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { formatRegisterDeathDate } from "@/components/cemetery/cemetery-register-model";

function entry(id: string, deathDate: string, overrides: Partial<CemeteryEntry> = {}): CemeteryEntry {
  return {
    id,
    name: `Coin ${id}`,
    symbol: id.toUpperCase(),
    pegCurrency: "USD",
    causeOfDeath: "abandoned",
    deathDate,
    peakMcap: 10_000_000,
    obituary: `Obituary for ${id}.`,
    sourceUrl: `https://example.com/${id}`,
    sourceLabel: "Example",
    ...overrides,
  };
}

describe("buildCemeteryRegisterRows", () => {
  const rows = buildCemeteryRegisterRows([
    entry("old", "2023-01"),
    entry("may-month", "2024-05", { peakMcap: 90_000_000 }),
    entry("may-day-unknown", "2024-05-10", { peakMcap: undefined }),
    entry("may-day-known", "2024-05-10", { peakMcap: 5_000_000 }),
  ]);

  it("keeps an unrecorded peak null instead of zero", () => {
    expect(rows.find((row) => row.id === "may-day-unknown")?.peak).toBeNull();
    const [zero] = buildCemeteryRegisterRows([entry("zero", "2024-01", { peakMcap: 0 })]);
    expect(zero.peak).toBeNull();
  });
});

describe("formatRegisterDeathDate", () => {
  it("labels a date at its recorded precision", () => {
    expect(formatRegisterDeathDate("2024-05-10")).toBe("May 10, 2024");
    expect(formatRegisterDeathDate("2024-09")).toBe("Sep 2024");
    expect(formatRegisterDeathDate("not a date")).toBe("not a date");
  });
});

describe("buildRegisterFilterOptions", () => {
  const entries = [
    entry("a", "2026-03", { pegCurrency: "EUR", archivedDataAvailable: true }),
    entry("b", "2026-01", { pegCurrency: "EUR", causeOfDeath: "regulatory" }),
    entry("c", "2024-06", { peakMcap: undefined }),
    entry(Object.keys(CASE_STUDY_CLIENT_BY_CEMETERY_ID)[0], "2024-02"),
  ];
  const options = buildRegisterFilterOptions(buildCemeteryStats(entries), buildCemeteryRegisterRows(entries));

  it("offers only years with records, newest first, with global counts", () => {
    expect(options.facets.year).toEqual([
      { value: "2026", label: "2026", count: 2 },
      { value: "2024", label: "2024", count: 2 },
    ]);
  });

  it("counts the record kinds, including case studies, across every record", () => {
    expect(Object.fromEntries(options.facets.record.map(({ value, count }) => [value, count]))).toEqual({
      tracked: 1,
      curated: 3,
      "case-study": 1,
    });
    expect(options.facets.peak.find(({ value }) => value === "not-recorded")?.count).toBe(1);
    expect(options.total).toBe(4);
  });
});
