import { describe, expect, it } from "vitest";
import { detailSnapshotSourceUpdatedAt } from "../detail-snapshot-inputs";

// docs/api-reference.md:124 and docs/process/worker-infrastructure-appendix.md:408
// admit legacy reconstruction only from a valid `Date`; producer clocks more than
// 60 s in the future are outside the shared timestamp allowance
// (worker/src/lib/api-freshness-age.ts:1). The helper feeds persisted snapshot
// lane clocks, and src/lib/api.ts:84-92 seeds any positive clock as `fresh`.
const YEAR_9999_MS = Date.UTC(9999, 0, 1);

function legacyHeaders(date: string): Headers {
  return new Headers({ Date: date, "X-Data-Age": "0", Age: "0" });
}

describe("detail snapshot legacy Date provenance", () => {
  it("keeps an ECMAScript-parsable but non-HTTP Date unavailable", () => {
    // V8 reads the bare four-digit year as a calendar year, not an HTTP-date.
    expect(Date.parse("9999")).toBe(YEAR_9999_MS);
    expect(detailSnapshotSourceUpdatedAt(undefined, legacyHeaders("9999"))).toBeNull();
  });

  it("keeps a well-formed but far-future HTTP Date unavailable", () => {
    expect(detailSnapshotSourceUpdatedAt(undefined, legacyHeaders(new Date(YEAR_9999_MS).toUTCString()))).toBeNull();
  });

  it("still reconstructs the clock from admitted Date and age evidence", () => {
    const sourceDateMs = 1_793_000_000_000;
    expect(detailSnapshotSourceUpdatedAt(undefined, new Headers({
      Date: new Date(sourceDateMs).toUTCString(),
      "X-Data-Age": "30",
      Age: "12",
    }))).toBe(sourceDateMs - 42_000);
  });
});
