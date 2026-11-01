import { describe, expect, it } from "vitest";
import { buildRankChangeChipDisplay, formatSignedPysDelta, YIELD_LEADERBOARD_CSV_COLUMNS, YIELD_COMPARE_CSV_COLUMNS } from "@/lib/yield-presentation";
import { makeYieldRanking, makeYieldProvenance } from "@shared/test-utils/yield-ranking-fixtures";
import type { YieldViewModelRow } from "@/lib/yield-view-model";
import { buildCsvWithPreamble } from "@/lib/exports/csv";
import { formatPreambleCsv } from "@/lib/exports/preamble";

describe("yield CSV projections", () => {
  const leaderboardHeaders = ["ID", "Symbol", "Name", "APY 30d (%)", "PYS", "PYS qualification", "PYS null reason", "Safety grade", "Safety score", "Safety provenance", "Yield source", "Yield type", "Source posture", "Source confidence", "Source risk penalty", "Source risk score", "Source age seconds", "Venue risk tier", "Evidence completeness (%)", "Benchmark", "TVL USD", "Stability (%)", "Warnings", "Provider URL"];
  const compareHeaders = ["ID", "Symbol", "Name", "APY 30d (%)", "PYS", "PYS qualification", "PYS null reason", "Safety grade", "Safety score", "Safety provenance", "Source", "Source posture", "Source risk score", "Venue risk tier", "Depth", "Stability (%)", "Benchmark", "TVL USD", "Warnings", "Provider URL"];

  it.each([
    ["leaderboard", YIELD_LEADERBOARD_CSV_COLUMNS],
    ["compare", YIELD_COMPARE_CSV_COLUMNS],
  ] as const)("exports an unavailable safety card as unknown, never NR in the %s CSV", (_name, columns) => {
    const row: YieldViewModelRow = {
      ...makeYieldRanking({
        pharosYieldScore: null,
        pysNullReason: "safety-unrated",
        safetyScore: null,
        safetyGrade: null,
        provenance: makeYieldProvenance({ safetyProvenance: "safety-snapshot-unavailable" }),
      }),
      peg: "USD", viewRank: 1, rankLabel: "#1", opportunity: "lending-opportunity",
      sourceDepthLens: "moderate", sourcePosture: "clean", cohortPercentile: null,
    };
    const cells = Object.fromEntries(columns.map((column) => [column.header, column.accessor(row, 0)]));
    expect(cells["Safety grade"]).toBe("unknown");
    expect(cells["Safety score"]).toBe("unknown");
    expect(cells["Safety provenance"]).toBe("safety-snapshot-unavailable");
  });

  it("keeps NR for a row published as not rated", () => {
    const row: YieldViewModelRow = {
      ...makeYieldRanking({ safetyScore: null, safetyGrade: "NR" }),
      peg: "USD", viewRank: 1, rankLabel: "#1", opportunity: "lending-opportunity",
      sourceDepthLens: "moderate", sourcePosture: "clean", cohortPercentile: null,
    };
    const cells = Object.fromEntries(YIELD_LEADERBOARD_CSV_COLUMNS.map((column) => [column.header, column.accessor(row, 0)]));
    expect(cells["Safety grade"]).toBe("NR");
    expect(cells["Safety score"]).toBe("NR");
  });

  it.each([
    ["scored", 50, "live-report-card", 5_000_000],
    ["NR", null, "live-report-card", 5_000_000],
    ["null TVL", 50, "live-report-card", null],
    ["opportunity safety", 50, "opportunity-safety", 5_000_000],
    ["default safety", 50, "default-safety", 5_000_000],
    ["unknown provenance", 50, undefined, 5_000_000],
  ] as const)("preserves both CSV byte projections for %s", (_name, pys, safetyProvenance, tvl) => {
    const row: YieldViewModelRow = {
      ...makeYieldRanking({
        pharosYieldScore: pys, sourceTvlUsd: tvl, pysNullReason: pys == null ? "missing-inputs" : null,
        provenance: makeYieldProvenance({ safetyProvenance }),
      }),
      peg: "USD", viewRank: 1, rankLabel: "#1", opportunity: "lending-opportunity",
      sourceDepthLens: "moderate", sourcePosture: "clean", cohortPercentile: null,
    };
    const common = ["usdc-circle", "USDC", "USD Coin", 5, pys ?? "NR", pys == null ? "NR" : "rated",
      pys == null ? "missing-inputs" : "", "A", 80, safetyProvenance ?? "unknown"];
    const leaderboardCells = [...common, "Compound V3 USDC", "lending-opportunity", "clean", "curated",
      "unknown", "unknown", "unknown", "unknown", "unknown", "USD 3M T-Bill", tvl ?? "unknown", 90, "", "https://example.com/compound"];
    const compareCells = [...common, "Compound V3 USDC", "clean", "unknown", "unknown", "moderate",
      90, "USD 3M T-Bill", tvl ?? "unknown", "", "https://example.com/compound"];
    const preamble = { endpoint: "yield-rankings", asOfISO: "2026-04-23T00:00:00.000Z", sourceUrl: "https://pharos.watch/yield/", methodologyLabel: "Yield current" };
    expect(buildCsvWithPreamble([row], YIELD_LEADERBOARD_CSV_COLUMNS, preamble))
      .toBe([formatPreambleCsv(preamble), leaderboardHeaders.join(","), leaderboardCells.join(",")].join("\n"));
    expect(buildCsvWithPreamble([row], YIELD_COMPARE_CSV_COLUMNS, preamble))
      .toBe([formatPreambleCsv(preamble), compareHeaders.join(","), compareCells.join(",")].join("\n"));
    const leaderboard = Object.fromEntries(YIELD_LEADERBOARD_CSV_COLUMNS.map((column) => [column.header, column.accessor(row, 0)]));
    for (const column of YIELD_COMPARE_CSV_COLUMNS) {
      const header = column.header === "Source" ? "Yield source" : column.header;
      if (header in leaderboard) expect(column.accessor(row, 0), header).toBe(leaderboard[header]);
    }
  });
});

describe("formatSignedPysDelta", () => {
  it("formats signed PYS deltas and suppresses non-finite values", () => {
    expect(formatSignedPysDelta(2.345)).toBe("+2.35 PYS");
    expect(formatSignedPysDelta(-12.34)).toBe("-12.3 PYS");
    expect(formatSignedPysDelta(0)).toBe("+0.00 PYS");
    expect(formatSignedPysDelta(Number.NaN)).toBe("");
  });
});

describe("buildRankChangeChipDisplay", () => {
  it("renders positive rankDelta as an upward rank improvement", () => {
    const display = buildRankChangeChipDisplay({
      rankDelta: 4,
      pysDelta: 2.5,
      primaryDriver: "apy",
    });

    expect(display).toMatchObject({
      arrow: "▲",
      signedRank: "+4",
      short: "APY",
    });
    expect(display?.colorClass).toContain("state-positive");
  });

  it("renders negative rankDelta as a rank decline", () => {
    const display = buildRankChangeChipDisplay({
      rankDelta: -2,
      pysDelta: -1.2,
      primaryDriver: "source-risk",
    });

    expect(display).toMatchObject({
      arrow: "▼",
      signedRank: "-2",
      short: "Source risk",
    });
    expect(display?.colorClass).toContain("state-danger");
  });
});
