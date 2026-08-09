import { describe, expect, it } from "vitest";
import {
  compareMethodologyVersions,
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
} from "../methodology-version";
import { DDR_METHODOLOGY_CHANGELOG, DDR_V2_EFFECTIVE_AT } from "../depeg-resolver-version";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG,
  SAFETY_SCORE_METHODOLOGY_VERSION,
} from "../methodology-versions/safety-score";

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
  it("resolves to the higher version when two entries share effectiveAt", () => {
    // Regression guard: v3.9 and v3.8 shared effectiveAt=1776211200 and the
    // loop was silently resolving to 3.8. The sort tiebreak must prefer the
    // higher version so the forward loop assigns it last.
    const methodology = createMethodologyVersion({
      currentVersion: "3.9",
      changelogPath: "/foo",
      changelog: [
        {
          version: "3.9",
          title: "",
          date: "",
          effectiveAt: 1000,
          summary: "",
          impact: [],
          commits: [],
          reconstructed: false,
        },
        {
          version: "3.8",
          title: "",
          date: "",
          effectiveAt: 1000,
          summary: "",
          impact: [],
          commits: [],
          reconstructed: false,
        },
        {
          version: "3.7",
          title: "",
          date: "",
          effectiveAt: 900,
          summary: "",
          impact: [],
          commits: [],
          reconstructed: false,
        },
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
        {
          version: "9.99",
          title: "",
          date: "",
          effectiveAt: 2000,
          summary: "",
          impact: [],
          commits: [],
          reconstructed: false,
        },
        {
          version: "10.0",
          title: "",
          date: "",
          effectiveAt: 1000,
          summary: "",
          impact: [],
          commits: [],
          reconstructed: false,
        },
      ],
    });

    expect(methodology.versionLabels).toEqual(["v10.0", "v9.99"]);
  });

  it("throws in dev/test when currentVersion drifts from the latest changelog entry", () => {
    expect(() =>
      createMethodologyVersion({
        currentVersion: "1.0",
        changelogPath: "/methodology/drift-test/",
        changelog: [
          {
            version: "2.0",
            title: "",
            date: "",
            effectiveAt: 1000,
            summary: "",
            impact: [],
            commits: [],
            reconstructed: false,
          },
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
