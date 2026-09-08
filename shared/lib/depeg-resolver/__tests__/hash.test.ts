import { describe, expect, it } from "vitest";
import {
  DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
  DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
  DDR_FORECAST_READINESS_VERSION,
} from "../../methodology-versions/depeg-resolver";
import { DDR_HASH_DOMAINS, stableJsonHashV1, stableJsonStringifyV1 } from "../hash";
import {
  attachDdrPublicRowHash,
  buildDdrManifestBasePayload,
  computeDdrPublicRowHash,
  validateDdrPublicCacheContract,
} from "../public-contract";

import { basePublicRow, validPublicPredictionResponse } from "./hash.test-support";

describe("stableJsonStringifyV1", () => {
  it("sorts object keys and omits undefined object fields", () => {
    expect(stableJsonStringifyV1({ b: 2, a: 1, c: undefined })).toBe('{"a":1,"b":2}');
    expect(stableJsonStringifyV1({ nested: { z: null, a: "x" } })).toBe('{"nested":{"a":"x","z":null}}');
  });

  it("preserves array order in serialization and same-domain hashes", () => {
    expect(stableJsonStringifyV1({ a: [2, 1] })).toBe('{"a":[2,1]}');
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicPrediction, { a: [2, 1] })).not.toBe(
      stableJsonHashV1(DDR_HASH_DOMAINS.publicPrediction, { a: [1, 2] }),
    );
  });

  it("domain-separates identical payloads", () => {
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicPrediction, { a: [2, 1] })).not.toBe(
      stableJsonHashV1(DDR_HASH_DOMAINS.publicNoCall, { a: [2, 1] }),
    );
  });

  it("rejects non-finite, unsafe, and non-plain values", () => {
    expect(() => stableJsonStringifyV1({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => stableJsonStringifyV1({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe/);
    expect(() => stableJsonStringifyV1({ value: new Date(0) })).toThrow(/Date/);
    expect(() => stableJsonStringifyV1([undefined])).toThrow(/undefined array/);
  });

  it("matches an independently calculated domain/payload SHA-256 vector", () => {
    // Python hashlib.sha256 over the literal canonical domain/payload JSON.
    expect(stableJsonHashV1(DDR_HASH_DOMAINS.publicPredictionIds, [1, 2, 3]))
      .toBe("1660bb816963fbe2880304529159126fdefb666a762d41da12a35803d1372bca");
  });

  it("hashes public rows without volatile publication fields or the row hash itself", () => {
    const row = basePublicRow();
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
    expect(computeDdrPublicRowHash({
      ...published,
      kind: "invalidated_prediction",
      originalKind: "prediction",
      originalOutcome: published.frozen,
      prediction: {
        ...published.prediction,
        state: "invalidated",
        source: "erratum",
        latestErratum: {
          state: "invalidated",
          id: 1,
          publicPredictionId: 7,
          incidentKey: "ddr2:test",
          eventId: 1,
          assessmentId: 9,
          reason: "input_corruption",
          createdAt: 400,
          operatorNote: "corrected input",
          rowHashBefore: hash,
          replacementAssessmentId: null,
          replacementRowHash: null,
          createdBy: "operator",
        },
        errataCount: 1,
        errataHistory: [],
      },
    })).toBe(hash);
  });

  it("hashes no-call rows with the same volatile-field exclusions as prediction rows", () => {
    const row = {
      ...basePublicRow("ddr2:nocall"),
      kind: "no_call",
      noCall: {
        lockedAt: 200,
        eventAgeAtLockSec: 100,
        missingReasons: ["No reviewed mint authority"],
        relatedContext: {
          dewsBand: null,
          dewsScore: null,
          liquidityScore: null,
          safetyGrade: null,
          safetyScore: null,
          supplyChange7dPct: null,
          supplyChange30dPct: null,
          mintSurge: null,
        },
      },
      frozen: null,
    };
    const hash = computeDdrPublicRowHash(row);
    const published = attachDdrPublicRowHash({
      ...row,
      prediction: {
        ...row.prediction,
        publicPredictionId: 17,
        publishedAt: 300,
        publicationSnapshotToken: "ddrpub:nocall",
        snapshotGeneration: 2,
      },
    }, hash);

    expect(computeDdrPublicRowHash(published)).toBe(hash);
    expect(computeDdrPublicRowHash({
      ...published,
      kind: "invalidated_prediction",
      originalKind: "no_call",
      originalOutcome: published.noCall,
      prediction: {
        ...published.prediction,
        state: "invalidated",
        source: "erratum",
        errataCount: 1,
        errataHistory: [],
      },
    })).toBe(hash);
  });

  it("includes forecast-readiness metadata in public row hashes when present", () => {
    const baseRow = {
      ...basePublicRow("ddr3:test", {
        lockedAt: 180,
        eventAgeAtLockSec: 80,
        predictionPolicyVersion: "readiness-72h-v1",
        predictionMethodologyVersion: "3.0",
        predictionMethodologyVersionLabel: "v3.0",
      }),
      frozen: { resolution: { tier: "recovery_likely", factors: [] } },
    };
    const readiness = {
      version: DDR_FORECAST_READINESS_VERSION,
      score: 0.8,
      threshold: DDR_FORECAST_READINESS_STRICT_EARLY_LOCK_THRESHOLD,
      strictEarlyLockReady: true,
      reasons: ["Required forecast-readiness inputs are present."],
      components: [
        {
          key: "input_coverage",
          label: "Input coverage",
          score: 1,
          weight: 0.3,
          reason: "Required forecast-readiness inputs are present.",
        },
      ],
    };
    const backstop = {
      version: DDR_FORECAST_READINESS_VERSION,
      delaySec: DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      backstopAt: 100 + DDR_FORECAST_READINESS_BACKSTOP_DELAY_SEC,
      reached: false,
    };

    expect(computeDdrPublicRowHash({
      ...baseRow,
      prediction: {
        ...baseRow.prediction,
        lockTrigger: "scheduled_24h",
      },
    })).toBe(computeDdrPublicRowHash(baseRow));

    const readinessHash = computeDdrPublicRowHash({
      ...baseRow,
      prediction: {
        ...baseRow.prediction,
        lockTrigger: "forecast_readiness",
        readiness,
        backstop,
      },
    });

    expect(readinessHash).not.toBe(computeDdrPublicRowHash(baseRow));
    expect(computeDdrPublicRowHash({
      ...baseRow,
      prediction: {
        ...baseRow.prediction,
        lockTrigger: "forecast_readiness",
        readiness: { ...readiness, score: 0.81 },
        backstop,
      },
    })).not.toBe(readinessHash);
  });

  it("keeps legacy readiness defaults out of manifest base payloads", () => {
    const response = validPublicPredictionResponse();
    Object.assign(response.rows[0].prediction, {
      lockTrigger: "scheduled_24h",
      readiness: null,
      backstop: null,
    });

    const payload = buildDdrManifestBasePayload(response) as {
      rows: Array<{ prediction: Record<string, unknown> }>;
    };

    expect(payload.rows[0]?.prediction).not.toHaveProperty("lockTrigger");
    expect(payload.rows[0]?.prediction).not.toHaveProperty("readiness");
    expect(payload.rows[0]?.prediction).not.toHaveProperty("backstop");
  });
});

describe("validateDdrPublicCacheContract", () => {
  it("accepts a valid public prediction manifest and returns the base payload hash", () => {
    const result = validateDdrPublicCacheContract(validPublicPredictionResponse());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.basePayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("validates numerically sorted IDs and hash keys independently of row order, excluding null IDs", () => {
    const response = validPublicPredictionResponse();
    const first = response.rows[0];
    if (first.kind !== "prediction") throw new Error("fixture row must be a prediction row");
    const second = {
      ...first,
      prediction: { ...first.prediction, publicPredictionId: 12, rowHash: "c".repeat(64) },
    };
    const unpublished = {
      ...first,
      prediction: { ...first.prediction, publicPredictionId: null, rowHash: null },
    };
    response.rows = [second, unpublished, first];
    response._meta.publicPredictionIds = [7, 12];
    response._meta.publicPredictionRowHashes = { "12": "c".repeat(64), "7": first.prediction.rowHash! };
    expect(validateDdrPublicCacheContract(response)).toMatchObject({ ok: true });
    response._meta.publicPredictionIds = [12, 7];
    expect(validateDdrPublicCacheContract(response)).toEqual({
      ok: false, reason: "public-prediction-id-set-mismatch",
    });
  });

  it("accepts its saved base hash and rejects stable payload changes against it", () => {
    const response = validPublicPredictionResponse();
    const result = validateDdrPublicCacheContract(response);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    response._meta.basePayloadHash = result.basePayloadHash;
    expect(validateDdrPublicCacheContract(response)).toEqual(result);
    response.rows[0].name = "Changed stable identity";
    expect(validateDdrPublicCacheContract(response)).toEqual({
      ok: false, reason: "base-payload-hash-mismatch",
    });
  });

  it.each([
    [
      "schema-version-mismatch",
      () => {
        const response = validPublicPredictionResponse();
        return { ...response, _meta: { ...response._meta, schemaVersion: 1 } };
      },
    ],
    [
      "public-prediction-id-set-mismatch",
      () => {
        const response = validPublicPredictionResponse();
        return { ...response, _meta: { ...response._meta, publicPredictionIds: [8] } };
      },
    ],
    [
      "public-prediction-row-hash-missing",
      () => {
        const response = validPublicPredictionResponse();
        return {
          ...response,
          rows: response.rows.map((row) => ({
            ...row,
            prediction: { ...row.prediction, rowHash: null },
          })),
        };
      },
    ],
    [
      "public-prediction-row-hash-key-set-mismatch",
      () => {
        const response = validPublicPredictionResponse();
        return { ...response, _meta: { ...response._meta, publicPredictionRowHashes: {} } };
      },
    ],
    [
      "public-prediction-row-hash-map-mismatch",
      () => {
        const response = validPublicPredictionResponse();
        return {
          ...response,
          _meta: { ...response._meta, publicPredictionRowHashes: { "7": "b".repeat(64) } },
        };
      },
    ],
    [
      "base-payload-hash-mismatch",
      () => {
        const response = validPublicPredictionResponse();
        return { ...response, _meta: { ...response._meta, basePayloadHash: "b".repeat(64) } };
      },
    ],
  ])("reports %s", (reason, buildResponse) => {
    expect(validateDdrPublicCacheContract(buildResponse() as Parameters<typeof validateDdrPublicCacheContract>[0]))
      .toEqual({ ok: false, reason });
  });
});
