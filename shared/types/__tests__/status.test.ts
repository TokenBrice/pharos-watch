import { describe, expect, it } from "vitest";
import { PublicStatusHistoryResponseSchema, StatusHistoryResponseSchema, StatusResponseSchema } from "../status";

import { reserveComposition, statusResponse } from "./status.test-support";

describe("StatusResponseSchema reserve composition contract", () => {
  it("parses reserve sync cursor and history observability fields", () => {
    const parsed = StatusResponseSchema.parse(statusResponse());

    expect(parsed.reserveComposition).toMatchObject({
      cursorTailState: "incomplete",
      cursorTailError: "cursor write failed",
      runBudgetTruncationCount: 2,
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

  it("rejects reserve composition payloads missing cursor observability fields", () => {
    const payload = statusResponse();
    const { cursorTailState: _cursorTailState, ...reserveWithoutCursorState } = payload.reserveComposition;

    const result = StatusResponseSchema.safeParse({
      ...payload,
      reserveComposition: reserveWithoutCursorState,
    });

    expect(result.success).toBe(false);
  });

  it("uses the same reserve composition contract for status history", () => {
    const result = StatusHistoryResponseSchema.safeParse({
      timestamp: 1_780_000_100,
      state: null,
      staleness: null,
      probe: statusResponse().probe,
      discrepancy: statusResponse().discrepancy,
      transitions: [],
      hasMore: false,
      reserveComposition: reserveComposition(),
    });

    expect(result.success).toBe(true);
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
