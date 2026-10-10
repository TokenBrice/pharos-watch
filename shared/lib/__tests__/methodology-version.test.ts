import { describe, expect, it } from "vitest";
import {
  compareMethodologyVersions,
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "../methodology-versions/base";
import { DDR_METHODOLOGY_CHANGELOG, DDR_V2_EFFECTIVE_AT } from "../methodology-versions/depeg-resolver";
import { LIQUIDITY_METHODOLOGY_VERSION, SAFETY_SCORE_METHODOLOGY_VERSION } from "../methodology-versions/constants";
import LIQUIDITY_SCORE_V6 from "../../data/methodology-changelogs/liquidity-score/v6.json";
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

  it("provides an LLM-facing description for every changelog", () => {
    expect(METHODOLOGY_CHANGELOG_REGISTRY).toHaveLength(11);
    for (const methodology of METHODOLOGY_CHANGELOG_REGISTRY) {
      expect(methodology.llmsDescription.trim(), methodology.key).not.toBe("");
    }
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
  });
});
