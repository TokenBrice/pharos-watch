import { describe, expect, it } from "vitest";
import { getEndpointDefinition, getSiteDataAccess, isAdminLikePath } from "@shared/lib/api-endpoints";
import { handleYieldSourceDecisions } from "../yield-source-decisions";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

function buildRequest(query = ""): { request: Request; url: URL } {
  const url = new URL(`https://ops-api.pharos.watch/api/yield-source-decisions${query}`);
  return {
    request: new Request(url.toString(), { method: "GET" }),
    url,
  };
}

describe("handleYieldSourceDecisions", () => {
  it("is registered as an admin no-cache endpoint outside the site-data lane", () => {
    const endpoint = getEndpointDefinition("/api/yield-source-decisions");

    expect(endpoint).toMatchObject({
      adminRequired: true,
      mutatingAdmin: false,
      cacheBypass: true,
      methods: ["GET"],
    });
    expect(isAdminLikePath("/api/yield-source-decisions")).toBe(true);
    expect(getSiteDataAccess("/api/yield-source-decisions")).toBe("denied");
  });

  it("requires admin auth before reading D1", async () => {
    const db = mockD1([], { requireMatch: true });
    const { request, url } = buildRequest();

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: false });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(db.getHistory()).toEqual([]);
  });

  it("rejects out-of-range query bounds", async () => {
    const db = mockD1([], { requireMatch: true });
    const { request, url } = buildRequest("?limit=26");

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: true });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.error).toBe("Invalid limit: must be between 1 and 25");
    expect(db.getHistory()).toEqual([]);
  });

  it("falls back when decision retention and public alternatives migrations are absent", async () => {
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        rows: [
          {
            generation_id: "yield-1772000000",
            started_at: 1_772_000_000,
            state: "published",
            cache_key: "yield-rankings",
            ranking_updated_at: 1_772_000_000,
            ranking_count: 1,
            source_row_count: 1,
            best_row_count: 1,
            decision_count: 1,
            published_at: 1_772_000_003,
            failed_at: null,
            failure_reason: null,
            metadata_json: null,
            created_at: 1_772_000_000,
          },
        ],
      },
      {
        match: "d.retention_reason",
        rows: [],
        throwError: new Error("D1_ERROR: no such column: d.retention_reason"),
      },
      {
        match: "stablecoin-decisions:legacy-schema",
        rows: [
          {
            generation_id: "yield-1772000000",
            stablecoin_id: "usdc-circle",
            selected_source_key: "defillama:best",
            selected_confidence_tier: "curated",
            selected_data_source: "defillama",
            selected_apy_30d: 4.7,
            selected_score: 82.5,
            selected_reason: "Curated source selected",
            previous_best_source_key: null,
            source_switch: 0,
            rejected_count: 0,
            alternatives_json: "[]",
            created_at: 1_772_000_000,
            retention_reason: null,
          },
        ],
      },
      {
        match: "FROM yield_source_decision_alternatives",
        rows: [],
        throwError: new Error("D1_ERROR: no such table: yield_source_decision_alternatives"),
      },
    ]);
    const { request, url } = buildRequest("?stablecoin=usdc-circle&includePublicAlternatives=1");

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: true });
    const body = await response.json() as {
      decisions: Array<{ retentionReason?: string | null; publicAlternatives?: unknown[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.decisions[0]?.retentionReason).toBeNull();
    expect(body.decisions[0]?.publicAlternatives).toEqual([]);
    expect(db.getHistory().some((entry) => entry.sql.includes("legacy-schema"))).toBe(true);
  });

  it("filters generation and decision rows by generation, state, and stablecoin", async () => {
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        matchBinds: ["yield-1772000000", "yield-1772000000", "published", "published", 10],
        rows: [
          {
            generation_id: "yield-1772000000",
            started_at: 1_772_000_000,
            state: "published",
            cache_key: "yield-rankings",
            ranking_updated_at: 1_772_000_000,
            ranking_count: 125,
            source_row_count: 180,
            best_row_count: 125,
            decision_count: 125,
            published_at: 1_772_000_003,
            failed_at: null,
            failure_reason: null,
            metadata_json: JSON.stringify({ rowsRejected: 3, sourceSwitches: 2 }),
            created_at: 1_772_000_000,
          },
        ],
      },
      {
        match: "FROM yield_source_decisions",
        matchBinds: ["usdc-circle", "yield-1772000000", "yield-1772000000", "published", "published", 5],
        rows: [
          {
            generation_id: "yield-1772000000",
            stablecoin_id: "usdc-circle",
            selected_source_key: "defillama:best",
            selected_confidence_tier: "curated",
            selected_data_source: "defillama",
            selected_apy_30d: 4.7,
            selected_score: 82.5,
            selected_reason: "Curated source selected",
            previous_best_source_key: "price-derived:legacy",
            source_switch: 1,
            rejected_count: 1,
            alternatives_json: JSON.stringify([
              {
                sourceKey: "defillama:auto",
                rejected: true,
                reason: "rejected: divergent lower-confidence source",
              },
            ]),
            created_at: 1_772_000_000,
          },
        ],
      },
    ], { requireMatch: true });
    const { request, url } = buildRequest(
      "?generationId=yield-1772000000&state=published&stablecoin=usdc-circle",
    );

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: true });
    const body = await response.json() as {
      filters: Record<string, unknown>;
      generations: Array<Record<string, unknown>>;
      decisions: Array<{
        selected: Record<string, unknown>;
        alternatives: Array<Record<string, unknown>>;
        sourceSwitch: boolean;
      }>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.filters).toMatchObject({
      generationId: "yield-1772000000",
      state: "published",
      stablecoinId: "usdc-circle",
      limit: 10,
      decisionLimit: 5,
    });
    expect(body.generations).toEqual([
      expect.objectContaining({
        generationId: "yield-1772000000",
        state: "published",
        metadata: { rowsRejected: 3, sourceSwitches: 2 },
      }),
    ]);
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0]?.selected).toEqual({
      sourceKey: "defillama:best",
      confidenceTier: "curated",
      dataSource: "defillama",
      apy30d: 4.7,
      score: 82.5,
      reason: "Curated source selected",
    });
    expect(body.decisions[0]?.sourceSwitch).toBe(true);
    expect(body.decisions[0]?.alternatives).toEqual([
      {
        sourceKey: "defillama:auto",
        rejected: true,
        reason: "rejected: divergent lower-confidence source",
      },
    ]);
    db.assertAllMatchesUsed();
  });

  it("returns retentionReason and publicAlternatives when includePublicAlternatives=1 is requested", async () => {
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        rows: [],
      },
      {
        match: "FROM yield_source_decisions",
        rows: [
          {
            generation_id: "yield-1773000000",
            stablecoin_id: "usdc-circle",
            selected_source_key: "defillama:best",
            selected_confidence_tier: "curated",
            selected_data_source: "defillama",
            selected_apy_30d: 4.7,
            selected_score: 82.5,
            selected_reason: "Curated source selected",
            previous_best_source_key: null,
            source_switch: 0,
            rejected_count: 1,
            alternatives_json: "[]",
            created_at: 1_773_000_000,
            retention_reason: "trend",
          },
        ],
      },
      {
        match: "FROM yield_source_decision_alternatives",
        rows: [
          {
            generation_id: "yield-1773000000",
            stablecoin_id: "usdc-circle",
            alt_source_key: "defillama-auto:compound-v3",
            alt_yield_source: "Compound V3",
            alt_apy30d_delta: -0.5,
            rejection_reason_code: "lower-confidence",
            recorded_at: 1_773_000_000,
          },
        ],
      },
    ]);
    const { request, url } = buildRequest("?stablecoin=usdc-circle&includePublicAlternatives=1");

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: true });
    const body = await response.json() as {
      filters: { includePublicAlternatives: boolean };
      decisions: Array<{
        retentionReason: string | null;
        publicAlternatives?: Array<{ sourceKey: string; rejectionReasonCode: string }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.filters.includePublicAlternatives).toBe(true);
    expect(body.decisions[0]?.retentionReason).toBe("trend");
    expect(body.decisions[0]?.publicAlternatives).toEqual([
      {
        sourceKey: "defillama-auto:compound-v3",
        yieldSource: "Compound V3",
        apy30dDelta: -0.5,
        rejectionReasonCode: "lower-confidence",
        recordedAt: 1_773_000_000,
      },
    ]);
  });

  it("returns compact generation summaries without raw evidence blobs", async () => {
    const db = mockD1([
      {
        match: "FROM yield_publication_generations",
        matchBinds: [null, null, null, null, 2],
        rows: [
          {
            generation_id: "yield-1772003600",
            started_at: 1_772_003_600,
            state: "failed",
            cache_key: "yield-rankings",
            ranking_updated_at: null,
            ranking_count: null,
            source_row_count: 10,
            best_row_count: 5,
            decision_count: 0,
            published_at: null,
            failed_at: 1_772_003_650,
            failure_reason: "schema-invalid",
            metadata_json: "{not-json",
            created_at: 1_772_003_600,
          },
          {
            generation_id: "yield-1772000000",
            started_at: 1_772_000_000,
            state: "published",
            cache_key: "yield-rankings",
            ranking_updated_at: 1_772_000_000,
            ranking_count: 100,
            source_row_count: 150,
            best_row_count: 100,
            decision_count: 100,
            published_at: 1_772_000_010,
            failed_at: null,
            failure_reason: null,
            metadata_json: null,
            created_at: 1_772_000_000,
          },
        ],
      },
    ], { requireMatch: true });
    const { request, url } = buildRequest("?limit=2");

    const response = await handleYieldSourceDecisions({ db, url, request, trustedAdmin: true });
    const body = await response.json() as {
      filters: { decisionLimit: number };
      generations: Array<Record<string, unknown>>;
      decisions: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.filters.decisionLimit).toBe(0);
    expect(body.decisions).toEqual([]);
    expect(body.generations).toEqual([
      expect.objectContaining({
        generationId: "yield-1772003600",
        state: "failed",
        failureReason: "schema-invalid",
        metadata: null,
        metadataMalformed: true,
      }),
      expect.objectContaining({
        generationId: "yield-1772000000",
        state: "published",
        metadata: null,
        metadataMalformed: false,
      }),
    ]);
    expect(JSON.stringify(body)).not.toContain("metadata_json");
    expect(JSON.stringify(body)).not.toContain("alternatives_json");
    db.assertAllMatchesUsed();
  });
});
