import { describe, expect, it } from "vitest";
import {
  findDigestSignalQuarantines,
  findQuarantinedDigestSignalClaims,
  isDigestSignalQuarantined,
} from "../digest-signal-quarantine";

// Live JSON-LD for https://pharos.watch/digest/2026-10-24/ carried
// "datePublished":"2026-10-24T08:05:25.000Z" (= 1792829125, the edition clock).
const USG_EDITION_AT = 1_792_829_125;
const USG_WEEK = { startAt: Date.parse("2026-10-19T00:00:00Z") / 1000, endAt: Date.parse("2026-10-25T23:59:59Z") / 1000 };
const flowClaims = (copy: string) => findQuarantinedDigestSignalClaims(copy, "flow", USG_WEEK);

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

  it("matches the USG flow incident on the edition clock only, at exact seconds", () => {
    const at = (edition: number, ingestion = edition) => findDigestSignalQuarantines("flow", { ingestion, edition });
    expect(at(USG_EDITION_AT).map((entry) => entry.stablecoinId)).toEqual(["usg-tangent"]);
    expect(at(USG_EDITION_AT - 1)).toEqual([]);
    expect(at(USG_EDITION_AT + 1)).toEqual([]);
    // The ingestion clock is ignored for an edition-basis entry.
    expect(at(USG_EDITION_AT - 1, USG_EDITION_AT)).toEqual([]);
    expect(at(USG_EDITION_AT, USG_EDITION_AT - 60)).toHaveLength(1);
    // The USDS liquidity entry keeps its ingestion basis and is not a flow entry.
    expect(findDigestSignalQuarantines("liquidity", { ingestion: INCIDENT_AT, edition: 0 })).toHaveLength(1);
    expect(findDigestSignalQuarantines("liquidity", { ingestion: 0, edition: INCIDENT_AT })).toEqual([]);
  });

  it.each([
    "USG saw $36.85M of net burns this week.",
    "USG pressure hit -$36.85M.",
    "USG was redeemed for $36.8M.",
    "Net burns of $36.9M in USG led the week.",
    "USG recorded 36.85 million of outflows.",
  ])("rejects the retracted USG burn claim: %s", (copy) => {
    expect(flowClaims(copy)).toHaveLength(1);
  });

  it.each([
    "USG held steady. USDT recorded $36.85M in net mints.",
    "USG minted $36.85M of new supply.",
    "USG burned $12.00M while USDT burned $36.85M.",
    "USG pressure was -$1.2M, near $136.85M of USDC mints.",
    "The earlier USG inventory burn of $36.85M was a correction, not pressure.",
  ])("allows unrelated, independently valid or corrective prose: %s", (copy) => {
    expect(flowClaims(copy)).toEqual([]);
  });

  it("does not apply the flow incident to weeks that exclude the edition", () => {
    expect(findQuarantinedDigestSignalClaims(
      "USG saw $36.85M of net burns.", "flow",
      { startAt: USG_WEEK.startAt - 7 * 86_400, endAt: USG_WEEK.startAt - 1 },
    )).toEqual([]);
  });
});
