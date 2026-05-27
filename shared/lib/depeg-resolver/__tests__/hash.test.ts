import { describe, expect, it } from "vitest";
import { DDR_HASH_DOMAINS, stableJsonHashV1, stableJsonStringifyV1 } from "../hash";
import { attachDdrPublicRowHash, computeDdrPublicRowHash } from "../public-contract";

describe("stableJsonStringifyV1", () => {
  it("sorts object keys and omits undefined object fields", () => {
    expect(stableJsonStringifyV1({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}');
    expect(stableJsonStringifyV1({ nested: { z: null, a: "x" } })).toBe('{"nested":{"a":"x","z":null}}');
  });

  it("keeps array order and domain-separates hashes", () => {
    const payload = { a: [2, 1] };

    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicPrediction, payload)).not.toBe(
      stableJsonHashV1(DDR_HASH_DOMAINS.publicNoCall, payload),
    );
  });

  it("rejects non-finite, unsafe, and non-plain values", () => {
    expect(() => stableJsonStringifyV1({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => stableJsonStringifyV1({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe/);
    expect(() => stableJsonStringifyV1({ value: new Date(0) })).toThrow(/Date/);
    expect(() => stableJsonStringifyV1([undefined])).toThrow(/undefined array/);
  });

  it("matches the SHA-256 output shape", () => {
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, [1, 2, 3])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes public rows without volatile publication fields or the row hash itself", () => {
    const row = {
      stablecoinId: "lusd-liquity",
      symbol: "LUSD",
      name: "Liquity USD",
      pegCurrency: "USD",
      governance: "decentralized",
      status: null,
      eventId: 1,
      incidentKey: "ddr2:test",
      startedAt: 100,
      direction: "below",
      kind: "prediction",
      prediction: {
        incidentKey: "ddr2:test",
        eligibleAt: 200,
        lockedAt: 200,
        eventAgeAtLockSec: 100,
        lockTiming: "on_time",
        policyDelaySec: 100,
        predictionPolicyVersion: "sticky-24h-v1",
        predictionMethodologyVersion: "2.0",
        predictionMethodologyVersionLabel: "v2.0",
        resolutionRubricVersion: "resolution-v1",
        durationModelVersion: "duration-v1",
        incidentGroupingVersion: "incident-v1",
        supportRulesVersion: "support-v1",
      },
      frozen: { resolution: { tier: "at_risk", factors: [] } },
    };
    const hash = computeDdrPublicRowHash(row);
    const published = attachDdrPublicRowHash({
      ...row,
      prediction: {
        ...row.prediction,
        publicPredictionId: 7,
        publishedAt: 300,
        publicationSnapshotToken: "ddrpub:test",
        snapshotGeneration: 2,
      },
    }, hash);

    expect(computeDdrPublicRowHash(published)).toBe(hash);
  });
});
