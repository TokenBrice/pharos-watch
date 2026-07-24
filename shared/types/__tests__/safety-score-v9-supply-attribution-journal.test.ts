import { describe, expect, it } from "vitest";
import {
  SupplyAttributionJournalByIdV1Schema,
  createSupplyAttributionJournalV1,
  type SupplyAttributionJournalV1Payload,
} from "../safety-score-v9-supply-attribution-journal";

const DIGEST = "a".repeat(64);

function payload(
  overrides: Partial<SupplyAttributionJournalV1Payload> = {},
): SupplyAttributionJournalV1Payload {
  return {
    schemaVersion: 1,
    lane: "supply-attribution",
    assetId: "wm-m0",
    attemptId: "supply-attribution:00000000-0000-4000-8000-000000000001",
    sourceId: "wm.reviewed-deployment-unit-partition.v1",
    sourceOriginClass: "onchain-observation",
    baseInputGenerationId: `report-cards-input:v1:${DIGEST}`,
    sourceGeneration: "report-cards:v8:fixture",
    registryFingerprint: DIGEST,
    routeInventoryDigest: DIGEST,
    attemptCode: "supply-attribution.collector.attempted",
    admissionCode: "supply-attribution.admission.accepted",
    fallbackCode: "supply-attribution.fallback.not-used",
    attemptedAtSec: 101,
    completedAtSec: 102,
    scoringClockSec: 100,
    sourceObservedAtSec: 99,
    failedRouteId: null,
    contentSha256: DIGEST,
    ...overrides,
  };
}

describe("Safety Score V9 supply attribution journal", () => {
  it("content-addresses bounded accepted and rejected attempt records", () => {
    const accepted = createSupplyAttributionJournalV1(payload());
    const rejected = createSupplyAttributionJournalV1(
      payload({
        attemptId:
          "supply-attribution:00000000-0000-4000-8000-000000000002",
        admissionCode: "supply-attribution.admission.rejected-identity-drift",
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        sourceObservedAtSec: null,
        failedRouteId:
          "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
        contentSha256: null,
      }),
    );

    expect(accepted.journalId).toMatch(
      /^supply-attribution-evidence:v1:[a-f0-9]{64}$/,
    );
    expect(rejected.journalId).not.toBe(accepted.journalId);
    expect(
      SupplyAttributionJournalByIdV1Schema.parse({
        "wm-m0": [rejected, accepted],
      })["wm-m0"],
    ).toEqual([accepted, rejected]);
  });

  it("records XAUT issuer disclosure plus onchain evidence distinctly", () => {
    const hybrid = createSupplyAttributionJournalV1(
      payload({
        assetId: "xaut-tether",
        sourceId: "xaut.canonical-lock-mint-group-partition.v2",
        sourceOriginClass: "issuer-disclosure-plus-onchain",
      }),
    );
    expect(hybrid).toMatchObject({
      assetId: "xaut-tether",
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      admissionCode: "supply-attribution.admission.accepted",
    });
  });

  it("rejects source and origin pairings that misstate evidence provenance", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          sourceOriginClass: "issuer-disclosure-plus-onchain",
        }),
      ),
    ).toThrow(/requires onchain-observation origin/);
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          assetId: "xaut-tether",
          sourceId:
            "xaut.canonical-lock-mint-group-partition.v2",
          sourceOriginClass: "onchain-observation",
        }),
      ),
    ).toThrow(/requires issuer-disclosure-plus-onchain origin/);
  });

  it("rejects incoherent state, future source evidence, secrets, and unknown fields", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          admissionCode: "supply-attribution.admission.rejected-upstream",
          fallbackCode: "supply-attribution.fallback.not-used",
          sourceObservedAtSec: null,
          contentSha256: null,
        }),
      ),
    ).toThrow(/aggregate-only fallback/);
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({ sourceObservedAtSec: 101 }),
      ),
    ).toThrow(/scoring clock/);
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({ failedRouteId: "https://rpc.example" }),
      ),
    ).toThrow();
    expect(() =>
      createSupplyAttributionJournalV1({
        ...payload(),
        unexpected: true,
      } as SupplyAttributionJournalV1Payload),
    ).toThrow();
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({ contentSha256: "not-a-digest" }),
      ),
    ).toThrow();
  });

  it("enforces the canonical serialized entry-size bound", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          attemptId: `attempt:${"a".repeat(180)}`,
          baseInputGenerationId: `input:${"b".repeat(180)}`,
          sourceGeneration: `source:${"c".repeat(180)}`,
        }),
      ),
    ).toThrow(/exceeds 1152 bytes/);
  });

  it("rejects duplicate attempts in the fixed-input projection", () => {
    const record = createSupplyAttributionJournalV1(payload());
    expect(() =>
      SupplyAttributionJournalByIdV1Schema.parse({
        "wm-m0": [record, record],
      }),
    ).toThrow(/duplicate attempt/);
  });
});
