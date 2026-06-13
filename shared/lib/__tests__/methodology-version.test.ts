import { describe, expect, it } from "vitest";
import {
  createMethodologyVersion,
  formatMethodologyDisplayDate,
  methodologyChangelogEntryId,
  toMethodologyVersionLabel,
} from "../methodology-version";
import { DDR_METHODOLOGY_CHANGELOG, DDR_V2_EFFECTIVE_AT } from "../depeg-resolver-version";

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
