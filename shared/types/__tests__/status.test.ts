import { describe, expect, it } from "vitest";
import { PublicStatusHistoryResponseSchema, StatusHistoryResponseSchema, StatusResponseSchema } from "../status";

import { reserveComposition, statusResponse } from "./status.test-support";

describe("StatusResponseSchema reserve composition contract", () => {
  it("parses reserve sync cursor and history observability fields", () => {
    const parsed = StatusResponseSchema.parse(statusResponse());

    expect(parsed.reserveComposition).toMatchObject({
      historyWriteGaps: [
        expect.objectContaining({
          stablecoinId: "usdc-circle",
          attemptId: "attempt-1",
        }),
      ],
    });
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
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["reserveComposition", "nextCursorStablecoinId"]);
    }
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
