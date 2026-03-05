import { describe, expect, it } from "vitest";
import {
  BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  getBlacklistTrackerMethodologyVersionAt,
  toBlacklistTrackerMethodologyVersionLabel,
} from "@shared/lib/blacklist-tracker-version";

describe("blacklist-tracker-version", () => {
  it("keeps current version aligned with latest changelog entry", () => {
    expect(BLACKLIST_TRACKER_METHODOLOGY_CHANGELOG[0]?.version).toBe(BLACKLIST_TRACKER_METHODOLOGY_VERSION);
    expect(toBlacklistTrackerMethodologyVersionLabel(BLACKLIST_TRACKER_METHODOLOGY_VERSION)).toBe(BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL);
  });

  it("resolves reconstructed version windows by timestamp", () => {
    expect(getBlacklistTrackerMethodologyVersionAt(1770625241)).toBe("1.0");
    expect(getBlacklistTrackerMethodologyVersionAt(1770794846)).toBe("1.1");
    expect(getBlacklistTrackerMethodologyVersionAt(1770795558)).toBe("1.2");
    expect(getBlacklistTrackerMethodologyVersionAt(1771000000)).toBe("2.0");
    expect(getBlacklistTrackerMethodologyVersionAt(1771426563)).toBe("2.1");
    expect(getBlacklistTrackerMethodologyVersionAt(1771432970)).toBe("2.2");
    expect(getBlacklistTrackerMethodologyVersionAt(1772010212)).toBe("3.0");
    expect(getBlacklistTrackerMethodologyVersionAt(1772013289)).toBe("3.1");
  });

  it("returns current version for non-finite timestamps", () => {
    expect(getBlacklistTrackerMethodologyVersionAt(Number.NaN)).toBe(BLACKLIST_TRACKER_METHODOLOGY_VERSION);
    expect(getBlacklistTrackerMethodologyVersionAt(Number.POSITIVE_INFINITY)).toBe(BLACKLIST_TRACKER_METHODOLOGY_VERSION);
  });
});
