import { describe, expect, it } from "vitest";
import { resolveBlacklistStatuses } from "../report-card-blacklist-matchers";
import { TRACKED_STABLECOINS } from "../stablecoins/registry";

describe("tracked blacklist status authority", () => {
  it("publishes every tracked review verbatim", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.size).toBe(TRACKED_STABLECOINS.length);
    for (const meta of TRACKED_STABLECOINS) {
      expect(resolved.get(meta.id)).toBe(meta.blacklistabilityReview?.reviewedStatus);
    }
  });

  it("keeps representative direct, upstream, possible, and no verdicts", () => {
    const resolved = resolveBlacklistStatuses(TRACKED_STABLECOINS);

    expect(resolved.get("usdc-circle")).toBe(true);
    expect(resolved.get("dai-makerdao")).toBe("inherited");
    expect(resolved.get("zchf-frankencoin")).toBe("possible");
    expect(resolved.get("lusd-liquity")).toBe(false);
  });
});
