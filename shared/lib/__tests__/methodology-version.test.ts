import { describe, expect, it } from "vitest";
import { createMethodologyVersion } from "../methodology-version";

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
