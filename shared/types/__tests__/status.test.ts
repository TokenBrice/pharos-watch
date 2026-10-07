import { describe, expect, it } from "vitest";
import { PublicStatusHistoryResponseSchema, StatusHistoryResponseSchema, StatusResponseSchema } from "../status";
import { CronRunSchema, CronInFlightSchema, ResourcePressureSchema } from "../status/cron";

import { makeReserveComposition, reserveComposition, statusResponse } from "./status.test-support";

describe("StatusResponseSchema reserve composition contract", () => {
  it("preserves both verified Worker markers and defaults pre-upgrade payloads to unavailable", () => {
    const workerVersions = {
      public: { scriptName: "stablecoin-api", workerVersion: "public-v1", activatedAt: 100 },
      heavy: { scriptName: "stablecoin-heavy", workerVersion: "heavy-v2", activatedAt: 200 },
    };
    expect(StatusResponseSchema.parse({ ...statusResponse(), workerVersions }).workerVersions).toEqual(workerVersions);
    expect(StatusResponseSchema.parse({ ...statusResponse(), workerVersions: undefined }).workerVersions)
      .toEqual({ public: null, heavy: null });
    expect(StatusResponseSchema.parse({ ...statusResponse(), workerVersions: { public: workerVersions.public, heavy: null } }).workerVersions.heavy).toBeNull();
    for (const heavy of [{}, { ...workerVersions.heavy, activatedAt: -1 }, { ...workerVersions.heavy, workerVersion: "" }]) {
      expect(StatusResponseSchema.safeParse({ ...statusResponse(), workerVersions: { public: null, heavy } }).success).toBe(false);
    }
  });
  it("validates one resource block for terminal and progress metadata while retaining job keys", () => {
    const resourcePressure = {
      phase: "intake", observedAt: 100,
      bodyCapBytes: 4, cacheCapBytes: null, cacheEntryCapBytes: null, maxConcurrentDecodes: 2,
      inputCapBytes: null, catalogMaxAssets: null, intakeBytes: 0, cacheBytes: null, rejectedBodies: 1,
      inputBytes: null, catalogAssets: null, intakeBasis: "actual-stream", cacheBasis: "unavailable",
      guard: "resource-budget-exceeded", platformOutcome: null, platformOutcomeSource: null,
      heapUsedBytes: null, heapUnavailableReason: "workers-runtime-no-heap-api",
    };
    const metadata = { resourcePressure, cursor: "coin-a" };
    expect(CronRunSchema.parse({ startedAt: 1, durationMs: 2, status: "ok", metadata }).metadata).toEqual(metadata);
    expect(CronInFlightSchema.parse({ startedAt: 1, updatedAt: 2, stale: false, metadata }).metadata).toEqual(metadata);
    for (const invalid of [
      { ...resourcePressure, intakeBytes: -1 }, { ...resourcePressure, cacheBytes: Infinity },
      { ...resourcePressure, inputBytes: 0.5 }, { ...resourcePressure, catalogAssets: Number.MAX_SAFE_INTEGER + 1 },
      { ...resourcePressure, phase: "x".repeat(81) }, { ...resourcePressure, heapUsedBytes: 0 },
      { ...resourcePressure, platformOutcome: "platform-abandoned" },
    ]) expect(ResourcePressureSchema.safeParse(invalid).success).toBe(false);
    expect(CronRunSchema.parse({ startedAt: 1, durationMs: 2, status: "ok", metadata: { legacy: true } }).metadata).toEqual({ legacy: true });
  });

  it("accepts additive cron reasons without requiring them on legacy runs", () => {
    const run = { startedAt: 1, durationMs: 2, status: "degraded" };
    expect(CronRunSchema.parse(run)).not.toHaveProperty("degradedReason");
    expect(CronRunSchema.parse({ ...run, degradedReason: "publication-held" }).degradedReason).toBe("publication-held");
  });
  it.each(["yield-winner", null])("preserves additive cache publication identity %s", (generationId) => {
    const publishedAt = generationId ? 1_800_000_000 : null;
    const parsed = StatusResponseSchema.parse({
      ...statusResponse(), caches: { "yield-data": {
        ageSeconds: 60, maxAge: 3600, healthy: true, generationId, publishedAt,
      } },
    });
    expect(parsed.caches["yield-data"]).toMatchObject({ generationId, publishedAt });
  });
  it("requires null measurements and a reason for unavailable reserve evidence", () => {
    const unavailable = makeReserveComposition({ status: "unavailable" });
    expect(StatusResponseSchema.parse({
      ...statusResponse(),
      reserveComposition: unavailable,
    }).reserveComposition).toEqual(unavailable);
    for (const invalid of [
      { ...unavailable, configuredCoins: 0 },
      { ...unavailable, freshCoverageRatio: 0 },
      { ...unavailable, reason: undefined },
    ]) {
      expect(StatusResponseSchema.safeParse({
        ...statusResponse(),
        reserveComposition: invalid,
      }).success).toBe(false);
    }
  });

  it("accepts older canary payloads without inventing complete-cohort diagnostics", () => {
    const parsed = StatusResponseSchema.parse({
      ...statusResponse(),
      canaries: {
        checkedAt: 100, status: "unknown", latestRunAt: null, maxAgeSec: 7200,
        totalChecks: 0, okCount: 0, degradedCount: 0, errorCount: 0, skippedCount: 0,
        staleCount: 0, checks: {},
      },
    });
    expect(parsed.canaries?.expectedCheckIds).toBeUndefined();
    expect(parsed.canaries?.missingCheckIds).toBeUndefined();
    expect(parsed.canaries?.status).toBe("unknown");
  });

  it.each([
    ["crons", { "sync-stablecoins": {} }],
    ["budgetOnlySurfaces", [{}]],
    ["dataQuality", {}],
    ["telegramBot", {}],
    ["datasetFreshness", {}],
    ["summary", {}],
    ["liquidityHealth", {}],
    ["yieldHealth", {}],
    ["publicationHealth", {}],
    ["dependencyHealth", {}],
    ["providerCircuitHealth", {}],
    ["canaries", {}],
    ["telegramSummary", {}],
    ["producerHeads", [{}]],
    ["workerVersions", {}],
    ["priceSourceHealth", {}],
    ["coingeckoPriceDiff", {}],
    ["d1Usage", {}],
    ["mintBurnReconciliation", {}],
    ["reserveDrift", [{}]],
    ["classificationWarnings", [{}]],
  ] as const)("rejects malformed %s section", (section, value) => {
    const result = StatusResponseSchema.safeParse({
      ...statusResponse(),
      [section]: value,
    });
    expect(result.success, `${section} should fail closed`).toBe(false);
  });


  it("accepts older status payloads without hardening supplements", () => {
    const legacyPayload: Record<string, unknown> = { ...statusResponse() };
    for (const key of ["publicationHealth", "dependencyHealth", "providerCircuitHealth", "canaries"]) {
      delete legacyPayload[key];
    }

    const parsed = StatusResponseSchema.parse(legacyPayload);

    expect(parsed.publicationHealth).toBeNull();
    expect(parsed.dependencyHealth).toBeNull();
    expect(parsed.providerCircuitHealth).toBeNull();
    expect(parsed.canaries).toBeNull();
  });

  it("accepts additive publication-health failed surface metadata", () => {
    const parsed = StatusResponseSchema.parse({
      ...statusResponse(),
      publicationHealth: {
        checkedAt: 1_780_000_100,
        surfaces: {},
        failedSurfaces: [
          {
            surface: "yield-rankings",
            code: "publication_surface_query_failed",
            message: "Publication surface query failed.",
          },
        ],
      },
      sectionErrors: {
        publicationHealth: {
          code: "publication_health_partial_failure",
          message: "Publication health partially unavailable.",
        },
      },
    });

    expect(parsed.publicationHealth?.failedSurfaces).toEqual([
      {
        surface: "yield-rankings",
        code: "publication_surface_query_failed",
        message: "Publication surface query failed.",
      },
    ]);
  });

  it.each([
    ["current", StatusResponseSchema],
    ["history", StatusHistoryResponseSchema],
  ] as const)("preserves and validates reserve deferred-cursor state in %s status", (_name, schema) => {
    const payload = { ...statusResponse(), transitions: [], hasMore: false };
    expect(schema.parse(payload).reserveComposition).toEqual(reserveComposition());
    const { nextCursorStablecoinId: _nextCursor, ...reserveWithoutNextCursor } = payload.reserveComposition;
    const result = schema.safeParse({ ...payload, reserveComposition: reserveWithoutNextCursor });
    expect(result.success).toBe(false);
  });

  it("preserves additive top-level status fields", () => {
    const parsed = StatusResponseSchema.parse({ ...statusResponse(), futureHealth: { status: "healthy" } });
    expect((parsed as Record<string, unknown>).futureHealth).toEqual({ status: "healthy" });
  });

  it("distinguishes omitted, false, and true history pagination", () => {
    const payload = { ...statusResponse(), transitions: [] };
    expect(StatusHistoryResponseSchema.parse(payload).hasMore).toBeNull();
    expect(StatusHistoryResponseSchema.parse({ ...payload, hasMore: false }).hasMore).toBe(false);
    expect(StatusHistoryResponseSchema.parse({ ...payload, hasMore: true }).hasMore).toBe(true);
  });

  it("accepts null reserve history but requires current reserve composition", () => {
    const payload = { ...statusResponse(), transitions: [], reserveComposition: null };
    expect(StatusHistoryResponseSchema.parse(payload).reserveComposition).toBeNull();
    const result = StatusResponseSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["reserveComposition"]);
    }
  });

  it("validates public status history payloads", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "degraded",
      lastChangedAt: 1_780_000_000,
      transitions: [
        {
          id: 1,
          from: "healthy",
          to: "degraded",
          transitionType: "degrade",
          reason: "cache stale",
          at: 1_780_000_000,
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed public status history status values", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "unknown",
      lastChangedAt: null,
      transitions: [],
    });

    expect(result.success).toBe(false);
  });

  it("rejects malformed public status history transition types", () => {
    const result = PublicStatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      currentStatus: "healthy",
      lastChangedAt: null,
      transitions: [
        {
          id: 1,
          from: "healthy",
          to: "degraded",
          transitionType: "pause",
          reason: "cache stale",
          at: 1_780_000_000,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
