import { describe, expect, it } from "vitest";
import {
  compareMethodologyVersions,
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
} from "../methodology-versions/base";
import type { MethodologyChangelogEntry } from "../../types/editorial-content";
import { DDR_METHODOLOGY_CHANGELOG, DDR_V2_EFFECTIVE_AT } from "../methodology-versions/depeg-resolver";
import { LIQUIDITY_METHODOLOGY_VERSION, SAFETY_SCORE_METHODOLOGY_VERSION } from "../methodology-versions/constants";
import LIQUIDITY_SCORE_V6 from "../../data/methodology-changelogs/liquidity-score/v6.json";
import SAFETY_SCORE_POLICY from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { liquidityTvlBasisEpoch } from "../dex-liquidity-evidence";
import {
  getMethodologyVersionAt,
  METHODOLOGY_CHANGELOG_REGISTRY,
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
} from "../methodology-versions/registry";

function entry(version: string, effectiveAt: number): MethodologyChangelogEntry {
  return { version, title: "", date: "", effectiveAt, summary: "", impact: [], commits: [], reconstructed: false };
}

describe("compareMethodologyVersions", () => {
  it("orders decimal methodology versions with leading-zero hundredths before tenths", () => {
    expect(compareMethodologyVersions("6.09", "6.1")).toBeLessThan(0);
    expect(compareMethodologyVersions("6.1", "6.09")).toBeGreaterThan(0);
    expect(compareMethodologyVersions("6.10", "6.1")).toBe(0);
    expect(compareMethodologyVersions("6.16", "6.11")).toBeGreaterThan(0);
  });

  it("orders multi-digit major versions numerically", () => {
    expect(compareMethodologyVersions("10.0", "9.99")).toBeGreaterThan(0);
    expect(compareMethodologyVersions("9.99", "10.0")).toBeLessThan(0);
  });

  it("rejects non-standard methodology version shapes", () => {
    expect(() => compareMethodologyVersions("1.0.0", "1.0")).toThrow(/two-segment/i);
  });
});

describe("createMethodologyVersion", () => {
  it("rejects a third decimal digit on versions activated from 2026-09-07 on", () => {
    expect(() =>
      createMethodologyVersion({
        currentVersion: "9.461",
        changelogPath: "/methodology/x",
        changelog: [entry("9.461", 1_788_739_200)],
      }),
    ).toThrow(/at most two decimal digits/i);
    expect(
      createMethodologyVersion({
        currentVersion: "9.47",
        changelogPath: "/methodology/x",
        changelog: [entry("9.47", 1_788_739_200), entry("9.461", 1_788_509_806)],
      }).currentVersion,
    ).toBe("9.47");
  });

  it("resolves to the higher version when two entries share effectiveAt", () => {
    // Regression guard: v3.9 and v3.8 shared effectiveAt=1776211200 and the
    // loop was silently resolving to 3.8. The sort tiebreak must prefer the
    // higher version so the forward loop assigns it last.
    const methodology = createMethodologyVersion({
      currentVersion: "3.9",
      changelogPath: "/foo",
      changelog: [
        entry("3.9", 1000),
        entry("3.8", 1000),
        entry("3.7", 900),
      ],
    });
    expect(methodology.getVersionAt(1000)).toBe("3.9");
    expect(methodology.getVersionAt(999)).toBe("3.7");
  });

  it("selects a two-digit major version as the latest changelog entry", () => {
    const methodology = createMethodologyVersion({
      currentVersion: "10.0",
      changelogPath: "/methodology/two-digit-major-test/",
      changelog: [
        entry("9.99", 2000),
        entry("10.0", 3000),
      ],
    });

    expect(methodology.versionLabels).toEqual(["v10.0", "v9.99"]);
  });

  it("rejects an activation timeline that rolls back to an older version", () => {
    expect(() =>
      createMethodologyVersion({
        currentVersion: "2.0",
        changelogPath: "/methodology/chronology-drift-test/",
        changelog: [
          entry("2.0", 1000),
          entry("1.9", 2000),
        ],
      }),
    ).toThrow(/activation chronology drift/i);
  });

  it("throws in dev/test when currentVersion drifts from the latest changelog entry", () => {
    expect(() =>
      createMethodologyVersion({
        currentVersion: "1.0",
        changelogPath: "/methodology/drift-test/",
        changelog: [
          entry("2.0", 1000),
        ],
      }),
    ).toThrow(/drift/i);
  });

  it("rejects malformed currentVersion even when the changelog is empty", () => {
    expect(() =>
      createMethodologyVersion({
        currentVersion: "1.0.0",
        changelogPath: "/methodology/malformed-test/",
        changelog: [],
      }),
    ).toThrow(/two-segment/i);
  });

  it("resolves ordinary activation boundaries and the outer timeline", () => {
    const methodology = createMethodologyVersion({
      currentVersion: "2.0",
      changelogPath: "/methodology/window-test/",
      changelog: [entry("2.0", 2000), entry("1.0", 1000)],
    });
    expect(methodology.getVersionAt(999)).toBe("1.0");
    expect(methodology.getVersionAt(1999)).toBe("1.0");
    expect(methodology.getVersionAt(2000)).toBe("2.0");
    expect(methodology.getVersionAt(3000)).toBe("2.0");
    for (const timestamp of [NaN, Infinity, -Infinity]) {
      expect(methodology.getVersionAt(timestamp)).toBe("2.0");
    }
  });

  it("uses the current version when no activation windows exist", () => {
    const methodology = createMethodologyVersion({
      currentVersion: "2.0",
      changelogPath: "/methodology/empty-test/",
      changelog: [],
    });
    expect(methodology.getVersionAt(0)).toBe("2.0");
  });
});

describe("Safety Score methodology head entry", () => {
  // Version-agnostic replacement for the per-release guard that had to be
  // hand-rewritten every time the version moved. The invariant it protected --
  // the entry, the current version, and the score migration land together --
  // is what `createMethodologyVersion` enforces and what 9.13 set as precedent.
  it("is the newest changelog entry and matches the current version", () => {
    const head = SAFETY_SCORE_METHODOLOGY_CHANGELOG[0];
    expect(head).toBeDefined();
    expect(head!.version).toBe(SAFETY_SCORE_METHODOLOGY_VERSION);
  });

  it("activates v10.17 at the next UTC midnight without relabeling prior scores", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.17");
    expect(release).toMatchObject({
      version: "10.17",
      date: "2026-10-11",
      effectiveAt: 1_791_763_200,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt("safety-score", 1_791_763_199)).toBe("10.16");
    expect(getMethodologyVersionAt("safety-score", 1_791_763_200)).toBe("10.17");
  });

  it("orders every changelog entry strictly newest-first", () => {
    for (let index = 1; index < SAFETY_SCORE_METHODOLOGY_CHANGELOG.length; index += 1) {
      const newer = SAFETY_SCORE_METHODOLOGY_CHANGELOG[index - 1]!;
      const older = SAFETY_SCORE_METHODOLOGY_CHANGELOG[index]!;
      expect(
        compareMethodologyVersions(newer.version, older.version),
        `${newer.version} must sort after ${older.version}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("methodology registry", () => {
  it("resolves every registered current version through the keyed API", () => {
    for (const methodology of METHODOLOGY_CHANGELOG_REGISTRY) {
      expect(getMethodologyVersionAt(methodology.key, Number.POSITIVE_INFINITY)).toBe(
        methodology.currentLabel.slice(1),
      );
    }
  });

  it.each([
    ["pricing-pipeline", "6.46", "6.48"],
  ] as const)("activates the October 11 %s cutover without relabeling prior publications", (key, previousVersion, version) => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === key)!;
    expect(methodology.entries.find((candidate) => candidate.version === version)).toMatchObject({
      date: "2026-10-11",
      effectiveAt: 1_791_763_200,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt(key, 1_791_763_199)).toBe(previousVersion);
    expect(getMethodologyVersionAt(key, 1_791_763_200)).toBe(version);
  });

  it("activates reviewed low-volume recovery without relabeling earlier pricing publications", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    expect(methodology.entries.find((candidate) => candidate.version === "6.49")).toMatchObject({
      date: "2026-10-12",
      effectiveAt: 1_791_849_600,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt("pricing-pipeline", 1_791_849_599)).toBe("6.48");
    expect(getMethodologyVersionAt("pricing-pipeline", 1_791_849_600)).toBe("6.49");
    expect(methodology.entries.find((candidate) => candidate.version === "6.50")).toMatchObject({
      date: "2026-10-13",
      effectiveAt: 1_791_936_000,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt("pricing-pipeline", 1_791_935_999)).toBe("6.49");
    expect(getMethodologyVersionAt("pricing-pipeline", 1_791_936_000)).toBe("6.50");
  });

  it("retains standalone Liquidity and Redemption versions at the campaign boundary", () => {
    expect(getMethodologyVersionAt("liquidity-score", 1_791_763_200)).toBe("6.94");
    expect(getMethodologyVersionAt("redemption-backstop", 1_791_763_200)).toBe("4.49");
  });

  it.each([
    ["safety-score", "10.14", "10.16"],
    ["stability-index", "3.66", "3.67"],
    ["redemption-backstop", "4.48", "4.49"],
    ["depeg-dews", "6.33", "6.34"],
    ["depeg-resolver", "4.6", "4.7"],
    ["pricing-pipeline", "6.45", "6.46"],
    ["blacklist-tracker", "4.2", "4.3"],
    ["liquidity-score", "6.93", "6.94"],
    ["mint-burn-flow", "6.23", "6.24"],
    ["yield", "8.47", "8.48"],
  ] as const)("retains the coordinated October 10 %s release boundary", (key, previousVersion, version) => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === key)!;
    const release = methodology.entries.find((candidate) => candidate.version === version)!;
    expect(release).toMatchObject({
      version,
      date: "2026-10-10",
      effectiveAt: 1_791_676_800,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt(key, release.effectiveAt - 1)).toBe(previousVersion);
    expect(getMethodologyVersionAt(key, release.effectiveAt)).toBe(version);
  });

  it("pins the historical chain-conservation Pricing release after v6.46", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    const release = methodology.entries.find((candidate) => candidate.version === "6.47")!;
    const previous = methodology.entries.find((candidate) => candidate.version === "6.46")!;
    expect(methodology.currentLabel).toBe("v6.66");
    expect(release).toMatchObject({
      version: "6.47",
      date: "2026-10-11",
      effectiveAt: 1_791_763_200,
      reconstructed: false,
    });
    expect(release.effectiveAt).toBeGreaterThan(previous.effectiveAt);
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt - 1)).toBe("6.46");
    // Both independently authored releases activate at this midnight; the newer
    // combined branch identity wins without rewriting main's historical entry.
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt)).toBe("6.48");
    const sofidRelease = methodology.entries.find((candidate) => candidate.version === "6.48")!;
    expect(sofidRelease.effectiveAt).toBe(release.effectiveAt);
    expect(sofidRelease.title).toBe("Observed SOFID consensus without nominal-par override");
    expect(release.title).toBe("Conserved historical missing-chain attribution");
    expect(methodology.entries.slice(0, 8).map((candidate) => candidate.version)).toEqual(["6.66", "6.65", "6.64", "6.63", "6.62", "6.61", "6.60", "6.59"]);
  });

  it("activates the October 28 Pricing releases at one cut, with 6.60 resolving from it", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    for (const version of ["6.58", "6.59", "6.60"]) {
      expect(methodology.entries.find((candidate) => candidate.version === version))
        .toMatchObject({ date: "2026-10-28", effectiveAt: 1_793_145_600, reconstructed: false });
    }
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_145_600 - 1)).toBe("6.57");
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_145_600)).toBe("6.60");
  });

  it("activates Pricing 6.61 at the October 29 cut", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    expect(methodology.entries.find((candidate) => candidate.version === "6.61"))
      .toMatchObject({ date: "2026-10-29", effectiveAt: 1_793_232_000, reconstructed: false });
    expect(methodology.entries.find((candidate) => candidate.version === "6.62"))
      .toMatchObject({ date: "2026-10-29", effectiveAt: 1_793_232_000, reconstructed: false });
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_232_000 - 1)).toBe("6.60");
    // sUSN's NAV opt-in ships as 6.62 at the same midnight cut, so the newer version resolves there.
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_232_000)).toBe("6.62");
  });

  it("activates the RedStone retirement at the October 30 cut", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    expect(methodology.entries.find((candidate) => candidate.version === "6.63"))
      .toMatchObject({ date: "2026-10-30", effectiveAt: 1_793_318_400, reconstructed: false });
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_318_400 - 1)).toBe("6.62");
    expect(getMethodologyVersionAt("pricing-pipeline", 1_793_318_400)).toBe("6.63");
  });

  it.each([
    ["safety-score", "10.17", "10.18"],
    ["redemption-backstop", "4.49", "4.5"],
    ["liquidity-score", "6.94", "6.95"],
  ] as const)("converges the October 14 drain release identity for %s", (key, previousVersion, version) => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === key)!;
    const release = methodology.entries.find((candidate) => candidate.version === version)!;
    expect(release).toMatchObject({ version, date: "2026-10-14", effectiveAt: 1_791_981_600, reconstructed: false });
    expect(getMethodologyVersionAt(key, release.effectiveAt - 1)).toBe(previousVersion);
    expect(getMethodologyVersionAt(key, release.effectiveAt)).toBe(version);
    expect(release.impact.join(" ")).toContain("Activation: 2026-10-14 12:40 UTC (release cut; 1791981600)");
    expect(release.impact.join(" ")).not.toMatch(/provisional|re-date/i);
  });

  it.each([
    ["pricing-pipeline", "6.50", "6.51"],
    ["redemption-backstop", "4.5", "4.51"],
    ["yield", "8.48", "8.49"],
    ["mint-burn-flow", "6.25", "6.26"],
  ] as const)("retains the provisional October 16 %s release boundary", (key, previousVersion, version) => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === key)!;
    const release = methodology.entries.find((candidate) => candidate.version === version)!;
    expect(release).toMatchObject({
      version,
      date: "2026-10-15",
      effectiveAt: 1_792_108_800,
      reconstructed: false,
    });
    expect(getMethodologyVersionAt(key, release.effectiveAt - 1)).toBe(previousVersion);
    expect(getMethodologyVersionAt(key, release.effectiveAt)).toBe(version);
  });

  it("pins quarter-hour short-lived price recovery to the next UTC release boundary", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    const release = methodology.entries.find((candidate) => candidate.version === "6.52")!;
    expect(release).toMatchObject({
      version: "6.52", date: "2026-10-16", effectiveAt: 1_792_195_200, reconstructed: false,
    });
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt - 1)).toBe("6.51");
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt)).toBe("6.52");
  });

  it("pins native Hive admission to its forward-only release boundary", () => {
    const methodology = METHODOLOGY_CHANGELOG_REGISTRY.find((candidate) => candidate.key === "pricing-pipeline")!;
    const release = methodology.entries.find((candidate) => candidate.version === "6.53")!;
    expect(release).toMatchObject({ version: "6.53", date: "2026-10-19", effectiveAt: 1_792_368_000, reconstructed: false });
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt - 1)).toBe("6.52");
    expect(getMethodologyVersionAt("pricing-pipeline", release.effectiveAt)).toBe("6.53");
    expect(release.impact.join(" ")).toContain("Activation: 2026-10-19 00:00 UTC (release date; 1792368000)");
    expect(release.impact.join(" ")).not.toMatch(/provisional|re-date/i);
  });

  it("retains the v10.19 Morpho release cut", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.19")!;
    expect(release).toMatchObject({
      version: "10.19",
      date: "2026-10-14",
      effectiveAt: 1_792_015_200,
      reconstructed: false,
      commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.18");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.19");
    expect(release.impact.join(" ")).toContain("Activation: 2026-10-14 22:00 UTC (release cut; 1792015200)");
    expect(release.impact.join(" ")).not.toMatch(/provisional|re-date/i);
    expect(release.impact.join(" ")).toMatch(/Morpho/);
  });

  it("retains the archive-free attribution release and aligns current Safety policy identity", () => {
    expect(SAFETY_SCORE_METHODOLOGY_VERSION).toBe("10.41");
    expect(SAFETY_SCORE_POLICY.releaseVersion).toBe(SAFETY_SCORE_METHODOLOGY_VERSION);
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.23")!;
    expect(release).toMatchObject({
      version: "10.23", date: "2026-10-19", effectiveAt: 1_792_368_000, reconstructed: false,
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.21");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.23");
  });

  it("discloses the wrapper-cohort correction at the next Safety release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.25")!;
    expect(release).toMatchObject({
      version: "10.25", date: "2026-10-20", effectiveAt: 1_792_540_800,
      commits: [], reconstructed: false,
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.24");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.25");
    expect(release.summary).toContain("wrapper cohort");
    expect(release.impact.join(" ")).toContain("executionCertainty");
    expect(release.impact.join(" ")).toContain("no grade changes");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("discloses grade hysteresis and redemption carry-forward at the next Safety release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.26")!;
    expect(release).toMatchObject({
      version: "10.26", date: "2026-10-21", effectiveAt: 1_792_627_200,
      commits: [], reconstructed: false,
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.25");
    // The highest numeric version wins when the shipped v10.26 and v10.27 cuts coincide.
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.27");
    expect(release.impact.join(" ")).toContain("gradeHold");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("discloses bounded chain-supply carry-forward at the next Safety release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.27")!;
    expect(release).toMatchObject({
      version: "10.27", date: "2026-10-21", effectiveAt: 1_792_627_200,
      commits: [], reconstructed: false,
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.25");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.27");
    expect(release.impact.join(" ")).toContain("5400s");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("retains the joint v10.28 release cut", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.28")!;
    expect(release).toMatchObject({
      version: "10.28", date: "2026-10-22", effectiveAt: 1_792_663_200, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.27");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.29");
    const impact = release.impact.join(" ");
    expect(impact).toMatch(/configured redemption channel/);
    expect(impact).toMatch(/issuer-undisclosed payout/);
    expect(impact).toMatch(/provider:<chain>:<contract>/);
    expect(release.summary).toMatch(/ships together with v10\.29/);
    expect(impact).not.toMatch(/25-asset issuer-backend cohort|OWNER DECISION \/ ISOLATABLE/);
    expect(impact).toMatch(/lender-collateral-classes-v1\.json/);
    expect(impact).not.toMatch(/at least two consecutive dated reports|source-bound danger witness/);
    expect(impact).toMatch(/aggregate share is at most 1%/);
    expect(impact).toMatch(/wrapperMildRiskFloorGrade D/);
    expect(impact).toMatch(/Preserve admitted exact-controller MPC\/HSM technical custody/);
    expect(impact).toMatch(/Current explicit mechanism-component reviews/);
    expect(impact).toContain("Activation: 2026-10-22 10:00 UTC (release cut; 1792663200). v10.28 and v10.29 ship together; production acceptance follows the first accepted publications.");
    expect(impact).not.toMatch(/provisional|re-date/i);
  });

  it("retains v10.29 as the highest version at the joint release cut", () => {
    const previous = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.28")!;
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.29")!;
    expect(release).toMatchObject({
      version: "10.29", date: "2026-10-22", effectiveAt: 1_792_663_200,
      reconstructed: false, commits: [],
    });
    expect(release.effectiveAt).toBe(previous.effectiveAt);
    expect(release.version).toMatch(/^\d+\.\d{1,2}$/);
    expect(compareMethodologyVersions(release.version, previous.version)).toBeGreaterThan(0);
    expect(getMethodologyVersionAt("safety-score", 1_792_663_199)).toBe("10.27");
    expect(getMethodologyVersionAt("safety-score", 1_792_663_200)).toBe("10.29");
    const impact = release.impact.join(" ");
    expect(impact).toMatch(/C\/U responsibility|issuer non-disclosure/);
    expect(impact).toMatch(/economic-authority ladder|weakest-effective-path ladder/);
    expect(impact).toMatch(/five cap families/);
    expect(impact).toMatch(/speculative-credit.*59/);
    expect(impact).toMatch(/at least 25%.*39.*at least 1%.*49/);
    expect(impact).toContain("Activation: 2026-10-22 10:00 UTC (release cut; 1792663200). v10.28 and v10.29 ship together; production acceptance follows the first accepted publications.");
    expect(impact).not.toMatch(/provisional|re-date/i);
  });

  it("records v10.30's release cut and uniform depeg/certificate calibration", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.30")!;
    expect(release).toMatchObject({
      version: "10.30", date: "2026-10-22", effectiveAt: 1_792_681_200,
      reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.29");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.30");
    const impact = release.impact.join(" ");
    expect(impact).toMatch(/at least 25%.*25.*at least 50%.*10.*F range/);
    expect(impact).toMatch(/model confidence.*0\.75 to 0\.85/);
    for (const example of ["yBOLD 70→72", "yvUSDC 65→68", "gtUSDC 66→69"]) {
      expect(impact).toContain(example);
    }
    expect(impact).toContain("VCRED is delisted from tracking");
    expect(impact).toContain("BD-basedollar mint authority");
    expect(impact).toContain("radar/partial-evidence display");
    expect(impact).toContain("Activation: 2026-10-22 15:00 UTC (release cut; 1792681200). Production acceptance follows the first accepted publications.");
    expect(impact).not.toMatch(/provisional|re-date/i);
  });

  it("records v10.30's integrated replay and dated evidence corrections without claiming production acceptance", () => {
    const impact = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.30")!.impact.join(" ");
    for (const detail of [
      "fixed-clock engine replay of production capture 2026-10-22T00:17Z against v10.29, not production acceptance",
      "15 rated-grade upgrades, 1 downgrade (dusd-dialectic C−51→D48 from privileged internal pricing) and 29 same-grade score changes",
      "A+ 1, A 8, A− 4, B+ 7, B 12, B− 30, C+ 74, C 75, C− 75, D 86, F 22",
      "The replay excluded the VCRED delisting, which removes one NR card",
      "pmUSD is capped at 10 (18→10)",
      "syrupUSDT, hbUSDT and DUSD (Control 60→45)",
      "spUSDT's chi/VSR accumulator is a savings-rate setter under the existing rule; its oracle profile does not price",
      "open-ended maturity facts for sYUSD and stkGHO",
      "Exit research found no admissible new execution models",
      "apyUSD, ctUSD, cUSDO, iUSD, mUSD, pUSD, sUSN, sYUSD, USDN, USDnr, USDSC and wM",
      "spUSDT's inherited Tether credits were also withdrawn (Control 90→65, score 64→60, still C+)",
      "Original review clocks are retained; the corrections are dated 2026-10-22",
      "score-neutral because Control remains 60, bound by the token-contract row",
      "The missing-data worklist routes all mechanism-review components; this is tooling only, with no score effect",
    ]) {
      expect(impact).toContain(detail);
    }
  });

  it("records v10.31's Q* release cut without claiming replay acceptance", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.31")!;
    expect(release).toMatchObject({
      version: "10.31", date: "2026-10-22", effectiveAt: 1792699200, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.30");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.31");
    expect(release.impact.join(" ")).toContain("Activation: 2026-10-22 20:00 UTC (release cut; 1792699200).");
    expect(release.impact.join(" ")).not.toMatch(/provisionally|re-date/i);
    expect(release.impact.join(" ")).toContain("no production acceptance is claimed");
    expect(release.impact.join(" ")).toContain("without trimming or rescaling");
    expect(release.impact.join(" ")).toContain("movers are post-cap");
    expect(release.impact.join(" ")).toContain("usdat 62.47→66.29 masked at 62");
  });

  it("discloses reviewed supply-attribution finality margins at the next Safety release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.33")!;
    expect(release).toMatchObject({
      version: "10.33", date: "2026-10-23", effectiveAt: 1_792_713_600, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.31");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.33");
    expect(release.impact.join(" ")).toContain("finalityMarginSecByChainId");
    expect(release.impact.join(" ")).toContain("MegaETH 1500s");
    expect(release.impact.join(" ")).not.toMatch(/provisional|re-date/i);
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("discloses the v10.34 reserve evidence admission calibration", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.34")!;
    expect(release).toMatchObject({
      version: "10.34", date: "2026-10-24", effectiveAt: 1_792_886_400, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.33");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.34");
    expect(release.impact.join(" ")).toContain("newer-unreviewed-report");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("discloses the v10.36 unrounded reserve composition shares", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.36")!;
    expect(release).toMatchObject({
      version: "10.36", date: "2026-10-28", effectiveAt: 1_793_145_600, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.34");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.36");
    expect(release.impact.join(" ")).toContain("0.04% credit slice");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

  it("discloses the v10.37 documentation class at its own release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.37")!;
    expect(release).toMatchObject({
      version: "10.37", date: "2026-10-30", effectiveAt: 1_793_318_400, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.36");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.37");
    const impact = release.impact.join(" ");
    expect(impact).toContain("One evidence level, unchanged");
    expect(impact).toContain("Zero declared movers, measured not assumed");
    expect(impact).toContain("re-date effectiveAt at release");
  });

  it("activates v10.38 evidence-method admission at its own release boundary", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.38")!;
    expect(release).toMatchObject({
      version: "10.38", date: "2026-10-30", effectiveAt: 1_793_354_400, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.37");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.38");
    const impact = release.impact.join(" ");
    expect(impact).toContain("exact-lower-bound");
    expect(impact).toContain("evaluationLagSec");
    expect(impact).toContain("chainSupplyMaxAgeBySource");
    expect(impact).toContain("Deployment supply census");
  });

  it("discloses the v10.35 asset-local measured-route expiry and bounded DEX capture admission", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.35")!;
    expect(release).toMatchObject({
      version: "10.35", date: "2026-10-28", effectiveAt: 1_793_145_600, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.34");
    // 10.36 activates at the same release cut, so the stacked newer version resolves there.
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.36");
    expect(release.impact.join(" ")).toContain("Expiry witnesses");
    expect(release.impact.join(" ")).toContain("4,500 seconds");
    expect(release.impact.join(" ")).toContain("no deployment or production acceptance is claimed");
  });

});

describe("DDR methodology version constants", () => {
  it("derives the v2 effective timestamp from the changelog entry", () => {
    const v2 = DDR_METHODOLOGY_CHANGELOG.find((entry) => entry.version === "2.0");

    expect(DDR_V2_EFFECTIVE_AT).toBe(1_779_897_600);
    expect(DDR_V2_EFFECTIVE_AT).toBe(v2?.effectiveAt);
  });
});

describe("methodology display helpers", () => {
  it("formats version labels and display dates consistently", () => {
    expect(toMethodologyVersionLabel("3.4")).toBe("v3.4");
    expect(formatMethodologyDisplayDate("2026-06-06")).toBe("Jun 6, 2026");
  });

  it("derives changelog entry ids from version labels", () => {
    expect(methodologyChangelogEntryId("3.01")).toBe("changelog-v-3-01");
  });
});

describe("liquidity TVL-basis break list", () => {
  it("breaks only at released liquidity versions at or below the current one", () => {
    const released = LIQUIDITY_SCORE_V6.map((changelogEntry) => changelogEntry.version)
      .sort((a, b) => Number(a) - Number(b));
    // No break above the current version: the current epoch is the last one.
    expect(liquidityTvlBasisEpoch(LIQUIDITY_METHODOLOGY_VERSION)).toBe(liquidityTvlBasisEpoch("999"));
    expect(liquidityTvlBasisEpoch(null)).toBe(0);
    // Between consecutive released versions the epoch never moves: every break is a released version.
    for (let index = 1; index < released.length; index++) {
      const justBelow = String(Number(released[index]) - 1e-6);
      expect(liquidityTvlBasisEpoch(justBelow)).toBe(liquidityTvlBasisEpoch(released[index - 1]));
    }
    expect(liquidityTvlBasisEpoch("6.9")).toBeLessThan(liquidityTvlBasisEpoch("6.91"));
    expect(liquidityTvlBasisEpoch("6.91")).toBeLessThan(liquidityTvlBasisEpoch("6.92"));
    expect(liquidityTvlBasisEpoch("6.92")).toBeLessThan(liquidityTvlBasisEpoch("6.93"));
    expect(liquidityTvlBasisEpoch("6.94")).toBe(liquidityTvlBasisEpoch("6.93"));
    expect(liquidityTvlBasisEpoch("6.95")).toBe(liquidityTvlBasisEpoch("6.94"));
    expect(liquidityTvlBasisEpoch("6.95")).toBeLessThan(liquidityTvlBasisEpoch("6.96"));
  });
  it("records v10.32's hourly-cadence activation and its derived bounds", () => {
    const release = SAFETY_SCORE_METHODOLOGY_CHANGELOG.find((candidate) => candidate.version === "10.32")!;
    expect(release).toMatchObject({
      version: "10.32", date: "2026-10-23", effectiveAt: 1792713600, reconstructed: false, commits: [],
    });
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt - 1)).toBe("10.31");
    expect(getMethodologyVersionAt("safety-score", release.effectiveAt)).toBe("10.33");
    const impact = release.impact.join(" ");
    expect(impact).toContain("from 3,600 to 7,200 seconds");
    expect(impact).toContain("lenderCollateralBacking");
    expect(impact).toContain("Released 2026-10-23 (effectiveAt 1792713600)");
  });

});
