import { describe, expect, it } from "vitest";
import {
  findQuarantinedDigestSignalClaims,
  isDigestSignalQuarantined,
} from "../digest-signal-quarantine";

const INCIDENT_AT = 1_787_299_523;

describe("digest signal quarantine", () => {
  it("uses inclusive incident boundaries without quarantining adjacent timestamps", () => {
    expect(isDigestSignalQuarantined("usds-sky", "liquidity", INCIDENT_AT)).toBe(true);
    expect(isDigestSignalQuarantined("usds-sky", "liquidity", INCIDENT_AT - 1)).toBe(false);
    expect(isDigestSignalQuarantined("usds-sky", "liquidity", INCIDENT_AT + 1)).toBe(false);
  });

  it("does not match the wrong coin or signal family", () => {
    expect(isDigestSignalQuarantined("susds-sky", "liquidity", INCIDENT_AT)).toBe(false);
    expect(isDigestSignalQuarantined("usds-sky", "yield", INCIDENT_AT)).toBe(false);
  });

  it("recognizes the retracted USDS collapse claim without catching the YLDS value coincidence", () => {
    expect(findQuarantinedDigestSignalClaims(
      "USDS liquidity collapsed as TVL fell from $162.28M to $13.72M.",
      "liquidity",
      { startAt: INCIDENT_AT, endAt: INCIDENT_AT },
    )).toHaveLength(1);
    expect(findQuarantinedDigestSignalClaims(
      "YLDS liquidity fell to $13.72M on 2026-06-22.",
      "liquidity",
      { startAt: 1_750_550_400, endAt: 1_750_636_799 },
    )).toEqual([]);
  });
});
