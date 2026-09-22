import { describe, expect, it } from "vitest";
import {
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  THREAT_BAND_LABELS,
} from "@shared/lib/classification";
import { GENIUS_STATUS_SHORT_LABELS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";

describe("classification descriptor semantics", () => {
  it("keeps DEWS severity labels distinguishable", () => {
    expect(new Set(Object.values(THREAT_BAND_LABELS)).size).toBe(Object.keys(THREAT_BAND_LABELS).length);
  });

  it.each([
    BACKING_LABELS,
    BACKING_LABELS_SHORT,
    GOVERNANCE_LABELS,
    GOVERNANCE_LABELS_SHORT,
  ])("keeps classification options distinguishable", (labels) => {
    expect(new Set(Object.values(labels)).size).toBe(Object.keys(labels).length);
  });

  it("distinguishes authorization outcomes without freezing editorial wording", () => {
    expect(new Set(Object.values(GENIUS_STATUS_SHORT_LABELS)).size)
      .toBe(Object.keys(GENIUS_STATUS_SHORT_LABELS).length);
    expect(new Set(Object.values(MICA_STATUS_BADGE_STYLES).map((badge) => badge.label)).size)
      .toBe(Object.keys(MICA_STATUS_BADGE_STYLES).length);
  });
});
