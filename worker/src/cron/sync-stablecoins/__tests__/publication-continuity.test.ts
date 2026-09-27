import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadStablecoinsPublicationContinuity } from "../publication";

describe("publication continuity provider priority", () => {
  it("does not prioritize healthy majors when persisted coverage is unreadable", async () => {
    const db = mockD1([{ match: "FROM cron_runs", rows: [{ metadata: '{"activePriceCoverage":"malformed"}' }] }]);
    const continuity = await loadStablecoinsPublicationContinuity(db, 1_790_461_000);
    expect(continuity.previousMissingGenerationsById.size).toBe(0);
    expect(continuity.previousActivePriceCoverage).toEqual({
      missingActiveIds: [], missingActiveAssets: [], unavailableReason: "previous-coverage-malformed",
    });
  });
});
