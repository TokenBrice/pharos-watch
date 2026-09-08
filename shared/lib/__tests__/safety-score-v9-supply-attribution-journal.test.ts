import { describe, expect, it } from "vitest";
import {
  SupplyAttributionJournalByIdV1Schema,
  SupplyAttributionJournalV1Schema,
  computeSupplyAttributionJournalIdV1,
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

function xautPayload(overrides: Partial<SupplyAttributionJournalV1Payload> = {}): SupplyAttributionJournalV1Payload {
  return payload({
    assetId: "xaut-tether",
    sourceId: "xaut.canonical-lock-mint-group-partition.v2",
    sourceOriginClass: "issuer-disclosure-plus-onchain",
    ...overrides,
  });
}

describe("Safety Score V9 supply attribution journal runtime", () => {
  it("content-addresses bounded accepted and rejected attempt records", () => {
    const accepted = createSupplyAttributionJournalV1(payload());
    const rejected = createSupplyAttributionJournalV1(
      payload({
        attemptId:
          "supply-attribution:00000000-0000-4000-8000-000000000002",
        admissionCode: "supply-attribution.admission.rejected-identity-drift",
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        rejectionCode: "deployment-identity-mismatch",
        sourceObservedAtSec: null,
        failedRouteId:
          "base:0x437cc33344a0b27a429f795ff6b469c72698b291",
        contentSha256: null,
      }),
    );

    expect(accepted.journalId).toBe(
      "supply-attribution-evidence:v1:9ae8937d6d507c1e7dd75a629d4f4e31803303181159dd4d154243a3a3f96836",
    );
    expect(rejected.journalId).not.toBe(accepted.journalId);
    expect(
      SupplyAttributionJournalByIdV1Schema.parse({
        "wm-m0": [rejected, accepted],
      })["wm-m0"],
    ).toEqual([accepted, rejected]);
    expect(
      JSON.stringify(
        SupplyAttributionJournalByIdV1Schema.parse({ "wm-m0": [accepted] }),
      ),
    ).toBe(
      '{"wm-m0":[{"schemaVersion":1,"lane":"supply-attribution","assetId":"wm-m0","attemptId":"supply-attribution:00000000-0000-4000-8000-000000000001","sourceId":"wm.reviewed-deployment-unit-partition.v1","sourceOriginClass":"onchain-observation","baseInputGenerationId":"report-cards-input:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceGeneration":"report-cards:v8:fixture","registryFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","routeInventoryDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","attemptCode":"supply-attribution.collector.attempted","admissionCode":"supply-attribution.admission.accepted","fallbackCode":"supply-attribution.fallback.not-used","attemptedAtSec":101,"completedAtSec":102,"scoringClockSec":100,"sourceObservedAtSec":99,"failedRouteId":null,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","journalId":"supply-attribution-evidence:v1:9ae8937d6d507c1e7dd75a629d4f4e31803303181159dd4d154243a3a3f96836"}]}'
    );
  });

  it("parses immutable pre-diagnostic V1 rows without changing their IDs", () => {
    const currentPayload = payload({
      admissionCode: "supply-attribution.admission.rejected-stale",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      rejectionCode: "safe-block-unavailable",
      sourceObservedAtSec: null,
      contentSha256: null,
    });
    const {
      rejectionCode: _rejectionCode,
      ...legacyPayload
    } = currentPayload;
    const legacyRecord = {
      ...legacyPayload,
      journalId: computeSupplyAttributionJournalIdV1(legacyPayload),
    };

    expect(SupplyAttributionJournalV1Schema.parse(legacyRecord)).toEqual(
      legacyRecord,
    );
    expect(() =>
      createSupplyAttributionJournalV1(
        legacyPayload as SupplyAttributionJournalV1Payload,
      ),
    ).toThrow(/exact leaf code/);
  });

  it("retains exact bounded XAUT rejection diagnostics", () => {
    const stale = createSupplyAttributionJournalV1(
      xautPayload({
        admissionCode: "supply-attribution.admission.rejected-stale",
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        rejectionCode: "transparency-stale",
        sourceObservedAtSec: 90,
        contentSha256: null,
      }),
    );

    expect(stale).toMatchObject({
      rejectionCode: "transparency-stale",
      sourceObservedAtSec: 90,
    });
    expect(() =>
      createSupplyAttributionJournalV1(
        xautPayload({
          admissionCode: "supply-attribution.admission.rejected-stale",
          fallbackCode: "supply-attribution.fallback.aggregate-only",
          rejectionCode: "transparency-stale",
          sourceObservedAtSec: null,
          contentSha256: null,
        }),
      ),
    ).toThrow(/requires its rejected source timestamp/);
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          rejectionCode: "transparency-stale",
        }),
      ),
    ).toThrow(/cannot emit transparency-stale/);
  });

  it("binds each exact rejection leaf to its aggregate admission class", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        xautPayload({
          admissionCode: "supply-attribution.admission.rejected-upstream",
          fallbackCode: "supply-attribution.fallback.aggregate-only",
          rejectionCode: "transparency-stale",
          sourceObservedAtSec: 90,
          contentSha256: null,
        }),
      ),
    ).toThrow(
      /transparency-stale requires supply-attribution\.admission\.rejected-stale/,
    );
  });

  it("records XAUT issuer disclosure plus onchain evidence distinctly", () => {
    const hybrid = createSupplyAttributionJournalV1(xautPayload());
    expect(hybrid).toMatchObject({
      assetId: "xaut-tether",
      sourceOriginClass: "issuer-disclosure-plus-onchain",
      admissionCode: "supply-attribution.admission.accepted",
    });
  });

  it("records Centrifuge deployment packets as onchain evidence", () => {
    const onchain = createSupplyAttributionJournalV1(
      payload({
        assetId: "acrdx-anemoy-apollo",
        sourceId: "centrifuge.reviewed-deployment-unit-partition.v1",
      }),
    );
    expect(onchain).toMatchObject({
      assetId: "acrdx-anemoy-apollo",
      sourceOriginClass: "onchain-observation",
      admissionCode: "supply-attribution.admission.accepted",
    });
  });

  it.each([
    [payload({ sourceOriginClass: "issuer-disclosure-plus-onchain" }), /requires onchain-observation origin/],
    [xautPayload({ sourceOriginClass: "onchain-observation" }), /requires issuer-disclosure-plus-onchain origin/],
  ])("rejects a mismatched provenance tuple %#", (record, error) => {
    expect(() => createSupplyAttributionJournalV1(record)).toThrow(error);
  });

  it("admits only the bounded wM finality exception after the scoring clock", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          completedAtSec: 220,
          sourceObservedAtSec: 220,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          completedAtSec: 221,
          sourceObservedAtSec: 221,
        }),
      ),
    ).toThrow(/scoring clock/);
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          completedAtSec: 101,
          sourceObservedAtSec: 102,
        }),
      ),
    ).toThrow(/scoring clock/);
    expect(() =>
      createSupplyAttributionJournalV1(
        xautPayload({
          sourceObservedAtSec: 101,
        }),
      ),
    ).toThrow(/scoring clock/);
  });

  it("rejects incoherent state, future source evidence, secrets, and unknown fields", () => {
    expect(() =>
      createSupplyAttributionJournalV1(
        payload({
          admissionCode: "supply-attribution.admission.rejected-upstream",
          fallbackCode: "supply-attribution.fallback.not-used",
          rejectionCode: "chain-rpc-unavailable",
          sourceObservedAtSec: null,
          contentSha256: null,
        }),
      ),
    ).toThrow(/aggregate-only fallback/);
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

  it("retains future XAUT timestamps only as rejected clock-skew diagnostics", () => {
    const record = createSupplyAttributionJournalV1(xautPayload({
      sourceObservedAtSec: 200,
      admissionCode: "supply-attribution.admission.rejected-skew",
      rejectionCode: "transparency-clock-skew",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
      contentSha256: null,
    }));
    expect(record).toMatchObject({
      sourceObservedAtSec: 200,
      admissionCode: "supply-attribution.admission.rejected-skew",
      rejectionCode: "transparency-clock-skew",
      contentSha256: null,
    });
  });

  it("rejects completion before attempt independently of source chronology", () => {
    expect(() => createSupplyAttributionJournalV1(payload({ completedAtSec: 100 }))).toThrow(/predate/);
  });

  it("requires accepted content, source time, and a successful route independently", () => {
    for (const override of [
      { contentSha256: null },
      { sourceObservedAtSec: null },
      { failedRouteId: "base:0x437cc33344a0b27a429f795ff6b469c72698b291" },
    ]) {
      expect(() => createSupplyAttributionJournalV1(payload(override))).toThrow(/requires content and source time/);
    }
  });

  it("rejects content retained by an otherwise coherent rejected record", () => {
    expect(() => createSupplyAttributionJournalV1(payload({
      admissionCode: "supply-attribution.admission.rejected-upstream",
      rejectionCode: "chain-rpc-unavailable",
      fallbackCode: "supply-attribution.fallback.aggregate-only",
    }))).toThrow(/rejected attribution cannot carry content/);
  });

  it("rejects a source-allowed rejection code on accepted evidence", () => {
    expect(() => createSupplyAttributionJournalV1(payload({
      rejectionCode: "chain-rpc-unavailable",
    }))).toThrow(/cannot carry a rejection code/);
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
