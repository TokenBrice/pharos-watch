import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { formatDeathDate, formatUtcDayLabel } from "@shared/lib/format";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import { buildCemeteryRegisterRows, buildRegisterFilterOptions } from "@/lib/cemetery-register";
import { buildCemeteryStats } from "@/lib/cemetery-stats";
import { formatRegisterDeathDate, sortRegisterRows } from "@/components/cemetery/cemetery-register-model";

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

  it("returns the day-aware newest-first order, and the register derives oldest-first from the same authority", () => {
    // Day-precise May 10 rows precede the bare May row; a known peak precedes an unknown one on the same day.
    expect(rows.map((row) => row.id)).toEqual(["may-day-known", "may-day-unknown", "may-month", "old"]);
    // Oldest first is not the reverse: the peak tie-break keeps its direction.
    expect(sortRegisterRows(rows, { key: "died", dir: "asc" }).map((row) => row.id)).toEqual([
      "old",
      "may-month",
      "may-day-known",
      "may-day-unknown",
    ]);
  });

  it("keeps an unrecorded peak null instead of zero", () => {
    expect(rows.find((row) => row.id === "may-day-unknown")?.peak).toBeNull();
    const [zero] = buildCemeteryRegisterRows([entry("zero", "2024-01", { peakMcap: 0 })]);
    expect(zero.peak).toBeNull();
  });

  it("separates the tracked archive from curated records", () => {
    const [tracked, curated] = buildCemeteryRegisterRows([
      entry("tracked", "2024-02", { archivedDataAvailable: true }),
      entry("curated", "2024-01"),
    ]);
    expect(tracked.tracked).toBe(true);
    expect(curated.tracked).toBe(false);
  });

  it("links the case study written about the record, and only that record", () => {
    const [caseStudyId] = Object.keys(CASE_STUDY_CLIENT_BY_CEMETERY_ID);
    const study = CASE_STUDY_CLIENT_BY_CEMETERY_ID[caseStudyId];
    const [withStudy, without] = buildCemeteryRegisterRows([
      entry(caseStudyId, "2024-02"),
      entry("no-study", "2024-01"),
    ]);
    expect(withStudy.caseStudy).toEqual({ slug: study.slug, title: study.title });
    expect(without.caseStudy).toBeNull();
  });

  it("resolves logos the way the cemetery does and keeps a missing logo null", () => {
    const projected = buildCemeteryRegisterRows([
      entry("bare", "2024-03", { logo: "bare.png" }),
      entry("absolute", "2024-02", { logo: "/logos/absolute.png" }),
      entry("none", "2024-01"),
    ]);
    expect(projected.map((row) => row.logoUrl)).toEqual(["/logos/cemetery/bare.png", "/logos/absolute.png", null]);
  });

  it("keeps a contract on an unknown chain without inventing an explorer link", () => {
    const [row] = buildCemeteryRegisterRows([
      entry("contracts", "2024-01", { contracts: [{ chain: "not-a-chain", address: "0xabc" }] }),
    ]);
    expect(row.contracts).toEqual([{ chainName: "not-a-chain", address: "0xabc", explorerUrl: null }]);
  });

  it("rejects a death date it cannot place at month precision", () => {
    expect(() => buildCemeteryRegisterRows([entry("bad", "2024-13")])).toThrow(/invalid deathDate/);
    expect(() => buildCemeteryRegisterRows([entry("year-only", "2024")])).toThrow(/invalid deathDate/);
  });

  it("projects every real record exactly once", () => {
    const real = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
    expect(new Set(real.map((row) => row.id)).size).toBe(CEMETERY_ENTRIES.length);
  });
});

describe("formatRegisterDeathDate", () => {
  it("labels a date at its recorded precision", () => {
    expect(formatRegisterDeathDate("2024-05-10")).toBe("May 10, 2024");
    expect(formatRegisterDeathDate("2024-09")).toBe("Sep 2024");
    expect(formatRegisterDeathDate("not a date")).toBe("not a date");
  });

  it("prints what the shared date formatters print for every real record", () => {
    for (const { deathDate } of CEMETERY_ENTRIES) {
      const [year, month, day] = deathDate.split("-").map(Number);
      const expected = day === undefined ? formatDeathDate(deathDate) : formatUtcDayLabel(new Date(Date.UTC(year, month - 1, day)));
      expect(formatRegisterDeathDate(deathDate)).toBe(expected);
    }
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

  it("orders pegs by count, then code", () => {
    expect(options.facets.peg.map(({ value, count }) => [value, count])).toEqual([
      ["EUR", 2],
      ["USD", 2],
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
