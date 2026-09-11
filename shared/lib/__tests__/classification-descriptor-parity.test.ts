import { describe, expect, it } from "vitest";
import {
  BACKING_LABELS,
  BACKING_LABELS_SHORT,
  GOVERNANCE_LABELS,
  GOVERNANCE_LABELS_SHORT,
  THREAT_BAND_LABELS,
  THREAT_BAND_ORDER,
} from "@shared/lib/classification";
import { GENIUS_STATUS_SHORT_LABELS } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";

describe("classification descriptor semantics", () => {
  it("preserves the increasing DEWS severity order", () => {
    expect(THREAT_BAND_ORDER).toEqual({ CALM: 0, WATCH: 1, ALERT: 2, WARNING: 3, DANGER: 4 });
    expect(Object.keys(THREAT_BAND_LABELS).sort()).toEqual(["ALERT", "CALM", "DANGER", "WARNING", "WATCH"]);
    expect(new Set(Object.values(THREAT_BAND_LABELS)).size).toBe(5);
  });

  it.each([
    [BACKING_LABELS, ["algorithmic", "crypto-backed", "rwa-backed"]],
    [BACKING_LABELS_SHORT, ["algorithmic", "crypto-backed", "rwa-backed"]],
    [GOVERNANCE_LABELS, ["centralized", "centralized-dependent", "decentralized"]],
    [GOVERNANCE_LABELS_SHORT, ["centralized", "centralized-dependent", "decentralized"]],
  ])("keeps classification options complete and distinguishable", (labels, keys) => {
    expect(Object.keys(labels).sort()).toEqual(keys);
    expect(new Set(Object.values(labels)).size).toBe(keys.length);
  });

  it("distinguishes authorization outcomes without freezing editorial wording", () => {
    expect(Object.keys(GENIUS_STATUS_SHORT_LABELS).sort()).toEqual([
      "issuer-announced-intent", "no-public-authorization-found", "not-applicable",
      "official-application-pending", "ppsi-approved", "state-qualified", "unknown",
    ]);
    expect(new Set(Object.values(GENIUS_STATUS_SHORT_LABELS)).size).toBe(7);
    expect(Object.keys(MICA_STATUS_BADGE_STYLES).sort()).toEqual(["authorized", "non-compliant", "out-of-scope", "pending", "transitional"]);
    expect(new Set(Object.values(MICA_STATUS_BADGE_STYLES).map((badge) => badge.label)).size).toBe(5);
  });
});
