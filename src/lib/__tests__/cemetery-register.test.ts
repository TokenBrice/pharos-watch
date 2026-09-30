import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { CASE_STUDY_CLIENT_BY_CEMETERY_ID } from "@/lib/case-study-client-index";
import { buildCemeteryRegisterRows, type CemeteryRegisterRow } from "@/lib/cemetery-register";

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

function byId(rows: CemeteryRegisterRow[], id: string): CemeteryRegisterRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
}

describe("buildCemeteryRegisterRows", () => {
  const rows = buildCemeteryRegisterRows([
    entry("old", "2023-01"),
    entry("may-month", "2024-05", { peakMcap: 90_000_000 }),
    entry("may-day-unknown", "2024-05-10", { peakMcap: undefined }),
    entry("may-day-known", "2024-05-10", { peakMcap: 5_000_000 }),
  ]);

  it("keeps the day-aware newest-first order and ranks both directions", () => {
    // Day-precise May 10 rows precede the bare May row; a known peak precedes an unknown one on the same day.
    expect(rows.map((row) => row.id)).toEqual(["may-day-known", "may-day-unknown", "may-month", "old"]);
    expect(rows.map((row) => row.defaultRank)).toEqual([0, 1, 2, 3]);
    const oldestFirst = [...rows].sort((a, b) => a.oldestRank - b.oldestRank).map((row) => row.id);
    expect(oldestFirst).toEqual(["old", "may-month", "may-day-known", "may-day-unknown"]);
  });

  it("labels the death date at its recorded precision", () => {
    expect(byId(rows, "may-day-known")).toMatchObject({ deathDateLabel: "May 10, 2024", precision: "day" });
    expect(byId(rows, "may-month")).toMatchObject({ deathDateLabel: "May 2024", precision: "month" });
  });

  it("keeps an unrecorded peak null instead of zero", () => {
    expect(byId(rows, "may-day-unknown")).toMatchObject({ peak: null, peakLabel: null });
    expect(byId(rows, "may-month")).toMatchObject({ peak: 90_000_000, peakLabel: "$90.0M" });
    const [zero] = buildCemeteryRegisterRows([entry("zero", "2024-01", { peakMcap: 0 })]);
    expect(zero).toMatchObject({ peak: null, peakLabel: null });
  });

  it("separates the tracked archive from curated records", () => {
    const [tracked, curated] = buildCemeteryRegisterRows([
      entry("tracked", "2024-02", { archivedDataAvailable: true }),
      entry("curated", "2024-01"),
    ]);
    expect(tracked).toMatchObject({ tracked: true, archivedUrl: "/stablecoin/tracked/" });
    expect(curated).toMatchObject({ tracked: false, archivedUrl: null });
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

  it("rejects a death date it cannot place", () => {
    expect(() => buildCemeteryRegisterRows([entry("bad", "2024-13")])).toThrow(/invalid deathDate/);
  });

  it("projects every real record exactly once", () => {
    const real = buildCemeteryRegisterRows(CEMETERY_ENTRIES);
    expect(new Set(real.map((row) => row.id)).size).toBe(CEMETERY_ENTRIES.length);
    expect(new Set(real.map((row) => row.oldestRank)).size).toBe(CEMETERY_ENTRIES.length);
  });
});
