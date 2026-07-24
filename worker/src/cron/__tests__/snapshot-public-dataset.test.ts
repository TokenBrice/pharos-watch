import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { buildDewsStablecoinIdsDigest } from "../../lib/dews-publication-pointer";
import * as activeSafetyScoreSource from "../../lib/safety-score-active-source";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../lib/safety-score-v9-consumer-freshness";
import { snapshotPublicDataset } from "../snapshot-public-dataset";

const ISO_DATE = "2026-05-16";
const NOW_MS = new Date(`${ISO_DATE}T08:00:00Z`).getTime();
const NOW_SEC = Math.floor(NOW_MS / 1000);
const EXPECTED_PSI_COMPUTED_AT = new Date("2026-05-15T00:00:00Z").getTime() / 1000;

const STABLECOINS_CACHE_PAYLOAD = {
  peggedAssets: [
    {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      price: 1.0,
      pegType: "peggedUSD",
      circulating: { peggedUSD: 50_000_000_000 },
    },
    {
      id: "usdt-tether",
      symbol: "USDT",
      name: "Tether",
      price: 1.0,
      pegType: "peggedUSD",
      circulating: { peggedUSD: 110_000_000_000 },
    },
  ],
};

const REPORT_CARD_PUBLICATION_GENERATION_ID = `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:${NOW_SEC}`;
const REPORT_CARD_CACHE_PAYLOAD = {
  methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
  scores: {
    "usdc-circle": { score: 92.4, grade: "A-" },
    "usdt-tether": { score: 78.1, grade: "B" },
  },
  updatedAt: NOW_SEC,
  safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    publicationGenerationId: REPORT_CARD_PUBLICATION_GENERATION_ID,
  }),
  publicationGenerationId: REPORT_CARD_PUBLICATION_GENERATION_ID,
  completeness: {
    generationId: REPORT_CARD_PUBLICATION_GENERATION_ID,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    expectedCount: ACTIVE_IDS.size,
    scoredCount: 2,
    notRatedCount: ACTIVE_IDS.size - 2,
    notRatedIds: [...ACTIVE_IDS].filter((id) => id !== "usdc-circle" && id !== "usdt-tether"),
  },
};

const PSI_ROW = {
  computed_at: EXPECTED_PSI_COMPUTED_AT,
  score: 87.4,
  band: "STEADY",
  components: JSON.stringify({ severity: 5, breadth: 2, stressBreadth: 1, trend: 0.5 }),
  methodology_version: "3.3",
};

const STRESS_ROWS = [
  {
    stablecoin_id: "usdc-circle",
    computed_at: NOW_SEC - 600,
    score: 18,
    band: "CALM",
    signals_json: JSON.stringify({ delta: 0.04 }),
  },
  {
    stablecoin_id: "usdt-tether",
    computed_at: NOW_SEC - 600,
    score: 24,
    band: "CALM",
    signals_json: JSON.stringify({ delta: 0.07 }),
  },
];

const DEX_ROWS = [
  {
    stablecoin_id: "usdc-circle",
    total_tvl_usd: 1_500_000_000,
    total_volume_24h_usd: 800_000_000,
    pool_count: 124,
    liquidity_score: 9.2,
    durability_score: 8.6,
    coverage_class: "deep",
    updated_at: 1779105600,
  },
];

function publishedDewsPointer(rows = STRESS_ROWS) {
  const computedAt = rows[0]?.computed_at ?? NOW_SEC - 600;
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: ["dews:published-generation"],
    rows: [
      {
        key: "dews:published-generation",
        value: JSON.stringify({
          updatedAt: computedAt,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: rows.length,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest(rows.map((row) => row.stablecoin_id)),
        }),
        updated_at: computedAt,
      },
    ],
  };
}

function buildDb(): MockD1Database {
  return mockD1([
    publishedDewsPointer(),
    {
      match: "FROM cache WHERE key",
      rows: [
        { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
        { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
      ],
    },
    { match: "FROM stability_index", rows: [], first: PSI_ROW },
    { match: "FROM stress_signals", rows: STRESS_ROWS },
    { match: "FROM dex_liquidity", rows: DEX_ROWS },
    { match: "INSERT OR IGNORE INTO public_snapshots", rows: [] },
  ]);
}

async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function getInsertBinds(db: MockD1Database): unknown[] | undefined {
  return db.getHistory().find((entry) => entry.sql.includes("INSERT OR IGNORE INTO public_snapshots"))?.binds;
}

function activeV9(updatedAt = NOW_SEC) {
  const snapshot = makeWorkerReportCardsV9Response({
    asOfSec: updatedAt - 60,
    updatedAt,
    cards: [
      makeWorkerV9Card({ id: "usdc-circle", score: 92, grade: "A+" }),
      makeWorkerV9Card({ id: "usdt-tether", score: 88, grade: "A+" }),
    ],
  });
  return {
    kind: "v9" as const,
    expectedModel: "v9" as const,
    marker: {
      policyId: snapshot.safetyScoreIdentity.policyId,
      policyDigest: snapshot.safetyScoreIdentity.policyDigest,
      evaluationBuildDigest: snapshot.safetyScoreIdentity.evaluationBuildDigest,
      methodologyVersion: snapshot.safetyScoreIdentity.methodologyVersion,
    },
    activationUpdatedAt: NOW_SEC - 30,
    snapshot,
  };
}

describe("snapshotPublicDataset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("snapshot-public-dataset aborted"));
    await expect(snapshotPublicDataset(mockD1(), controller.signal)).rejects.toThrow("snapshot-public-dataset aborted");
  });

  it("degrades gracefully when the stablecoins cache is missing", async () => {
    const db = mockD1([{ match: "FROM cache WHERE key", rows: [] }]);
    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toContain("stablecoins_cache_unavailable");

    const insert = db.getHistory().find((entry) => entry.sql.includes("INSERT OR IGNORE INTO public_snapshots"));
    expect(insert).toBeUndefined();
  });

  it("degrades before immutable insert when the stablecoins cache predates the scheduled slot", async () => {
    const staleForSlotUpdatedAt = NOW_SEC - 15 * 60;
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: staleForSlotUpdatedAt },
        ],
      },
    ]);

    const result = await snapshotPublicDataset(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: NOW_SEC,
      freshnessGateLabel: "daily0800Utc",
    });

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt: staleForSlotUpdatedAt,
      requiredUpdatedAt: NOW_SEC,
      freshnessGateLabel: "daily0800Utc",
    });
    expect(getInsertBinds(db)).toBeUndefined();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stability_index"))).toBe(false);
  });

  it("retries a pre-slot stablecoins cache before degrading", async () => {
    const staleForSlotUpdatedAt = NOW_SEC - 15 * 60;
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: staleForSlotUpdatedAt },
        ],
      },
    ]);

    const resultPromise = snapshotPublicDataset(db, undefined, {
      minStablecoinsCacheUpdatedAtSec: NOW_SEC,
      freshnessGateLabel: "daily0800Utc",
      stablecoinsCacheRetryAttempts: 2,
      stablecoinsCacheRetryDelayMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await resultPromise;

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "stablecoins_cache_before_slot",
      cacheUpdatedAt: staleForSlotUpdatedAt,
      requiredUpdatedAt: NOW_SEC,
      freshnessGateLabel: "daily0800Utc",
      retryAttempts: 2,
      firstCacheUpdatedAt: staleForSlotUpdatedAt,
    });
    expect(db.getHistory().filter((entry) => entry.sql.includes("FROM cache WHERE key"))).toHaveLength(3);
    expect(getInsertBinds(db)).toBeUndefined();
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM stability_index"))).toBe(false);
  });

  it("skips without recomputing when today's immutable snapshot already exists", async () => {
    const db = mockD1([
      {
        match: "FROM public_snapshots WHERE snapshot_date",
        rows: [],
        first: {
          content_hash: "existing-hash",
          byte_size: 1234,
          created_at: NOW_SEC - 60,
        },
      },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toContain("already_exists");
    expect(db.getHistory().some((entry) => entry.sql.includes("FROM cache WHERE key"))).toBe(false);
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("inserts a row keyed on today's UTC date with the expected envelope", async () => {
    const db = buildDb();
    const result = await snapshotPublicDataset(db);

    expect(result.itemCount).toBe(1);

    const binds = getInsertBinds(db);
    expect(binds).toBeDefined();
    expect(binds?.[0]).toBe(ISO_DATE);
    expect(binds?.[1]).toBeInstanceOf(Uint8Array);
    expect(binds?.[3]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(typeof binds?.[4]).toBe("number");
    expect(binds?.[5]).toBe(NOW_SEC);

    const methodologyVersionsStr = binds?.[2] as string;
    const methodologyVersions = JSON.parse(methodologyVersionsStr) as Record<string, string>;
    expect(methodologyVersions).toHaveProperty("pegScore");
    expect(methodologyVersions).toHaveProperty("dews");
    expect(methodologyVersions).toHaveProperty("psi");
    expect(methodologyVersions).toHaveProperty("liquidityScore");
    const insert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO public_snapshots")
    );
    expect(insert?.sql).toContain("json_extract(value, '$.publicationGenerationId')");
    expect(insert?.binds.slice(-3)).toEqual([
      "safety-score-v9:public-activation",
      "report_card_cache",
      REPORT_CARD_PUBLICATION_GENERATION_ID,
    ]);
  });

  it("compresses a JSON envelope that round-trips back to the expected shape", async () => {
    const db = buildDb();
    await snapshotPublicDataset(db);

    const binds = getInsertBinds(db);
    const payloadGz = binds?.[1] as Uint8Array;
    const byteSize = binds?.[4] as number;

    const decompressed = await gunzipToText(payloadGz);
    const envelope = JSON.parse(decompressed) as {
      snapshotDate: string;
      generatedAt: number;
      methodologyVersions: Record<string, string>;
      stablecoins: { id: string }[];
      reportCards: { scores: Record<string, unknown> } | null;
      psi: { score: number; band: string } | null;
      dews: { stablecoinId: string }[];
      liquidity: { stablecoinId: string }[];
    };

    expect(envelope.snapshotDate).toBe(ISO_DATE);
    expect(envelope.generatedAt).toBe(NOW_SEC);
    expect(envelope.stablecoins).toHaveLength(2);
    expect(envelope.stablecoins.map((c) => c.id).sort()).toEqual(["usdc-circle", "usdt-tether"]);
    expect(envelope.reportCards?.scores).toHaveProperty("usdc-circle");
    expect(envelope.psi?.score).toBe(87.4);
    expect(envelope.psi?.band).toBe("STEADY");
    expect(envelope.dews).toHaveLength(2);
    expect(envelope.liquidity).toHaveLength(1);
    expect(envelope.liquidity[0]?.stablecoinId).toBe("usdc-circle");

    expect(new TextEncoder().encode(decompressed).byteLength).toBe(byteSize);
  });

  it("produces a stable content hash for the same input", async () => {
    const db1 = buildDb();
    const db2 = buildDb();

    await snapshotPublicDataset(db1);
    await snapshotPublicDataset(db2);

    const binds1 = getInsertBinds(db1);
    const binds2 = getInsertBinds(db2);
    expect(binds1?.[3]).toBe(binds2?.[3]);
  });

  it("degrades instead of writing when the report-card cache is missing", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [{ key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC }],
      },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("active_safety_score_unavailable");
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not publish an immutable snapshot from an identity-less compact cache", async () => {
    const legacyReportCardCache = {
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      scores: REPORT_CARD_CACHE_PAYLOAD.scores,
      updatedAt: NOW_SEC,
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(legacyReportCardCache), updated_at: NOW_SEC },
        ],
      },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_unavailable",
      expectedModel: "v8",
      sourceReason: "identity-missing",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not publish an immutable snapshot from a different evaluation build", async () => {
    const mismatchedReportCardCache = {
      ...REPORT_CARD_CACHE_PAYLOAD,
      safetyScoreIdentity: {
        ...REPORT_CARD_CACHE_PAYLOAD.safetyScoreIdentity,
        evaluationBuildDigest: "b".repeat(64),
      },
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(mismatchedReportCardCache), updated_at: NOW_SEC },
        ],
      },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_unavailable",
      expectedModel: "v8",
      sourceReason: "identity-mismatch",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not publish an immutable snapshot from a complete V9 compact publication on the V8 release", async () => {
    const v9GenerationId = `safety-score-v9:9.0:${NOW_SEC}`;
    const v9ReportCardCache = {
      ...REPORT_CARD_CACHE_PAYLOAD,
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        policyId: "v9-policy-2026-05",
        policyDigest: "b".repeat(64),
        evaluationBuildDigest: "c".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
        publicationGenerationId: v9GenerationId,
      },
      publicationGenerationId: v9GenerationId,
      completeness: {
        ...REPORT_CARD_CACHE_PAYLOAD.completeness,
        generationId: v9GenerationId,
      },
    };
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(v9ReportCardCache), updated_at: NOW_SEC },
        ],
      },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_unavailable",
      expectedModel: "v8",
      sourceReason: "invalid-payload",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("writes the complete active V9 publication with model-aware methodology metadata", async () => {
    const source = activeV9();
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValue(source);
    const db = buildDb();

    const result = await snapshotPublicDataset(db);

    expect(result.itemCount).toBe(1);
    const binds = getInsertBinds(db);
    const envelope = JSON.parse(await gunzipToText(binds?.[1] as Uint8Array)) as {
      methodologyVersions: { reportCard: string };
      safetyScoreIdentity: { model: string; publicationGenerationId: string };
      reportCards: { lifecycle: string; cards: Array<{ id: string }> };
    };
    expect(envelope.methodologyVersions.reportCard).toBe(
      source.snapshot.safetyScoreIdentity.methodologyVersion,
    );
    expect(envelope.safetyScoreIdentity).toEqual(source.snapshot.safetyScoreIdentity);
    expect(envelope.reportCards.lifecycle).toBe("active");
    expect(envelope.reportCards.cards.map((card) => card.id)).toEqual([
      "usdc-circle",
      "usdt-tether",
    ]);

    const insert = db.getHistory().find((entry) =>
      entry.sql.includes("INSERT OR IGNORE INTO public_snapshots")
    );
    expect(insert?.sql).toContain("json_extract(value, '$.policyId')");
    expect(insert?.sql).toContain("json_extract(value, '$.identity.publicationGenerationId')");
    expect(insert?.binds.slice(-8)).toEqual([
      "safety-score-v9:public-activation",
      source.activationUpdatedAt,
      source.marker.policyId,
      source.marker.policyDigest,
      source.marker.evaluationBuildDigest,
      source.marker.methodologyVersion,
      "report-cards:v9-shadow",
      source.snapshot.safetyScoreIdentity.publicationGenerationId,
    ]);
  });

  it("does not seal a stale active V9 publication", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValue(activeV9(NOW_SEC - SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC - 1));
    const db = buildDb();

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_unavailable",
      expectedModel: "v9",
      sourceReason: "stale-cache",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not seal a V9 envelope when rollback races the immutable insert", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValueOnce(activeV9())
      .mockResolvedValueOnce({
        kind: "v8",
        expectedModel: "v8",
        reason: "activation-marker-missing",
        activationUpdatedAt: null,
      });
    const db = buildDb();

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_changed_before_insert",
      expectedModel: "v9",
      observedModel: "v8",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not seal a V8 envelope when activation races the immutable insert", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource")
      .mockResolvedValueOnce({
        kind: "v8",
        expectedModel: "v8",
        reason: "activation-marker-missing",
        activationUpdatedAt: null,
      })
      .mockResolvedValueOnce(activeV9());
    const db = buildDb();

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "active_safety_score_changed_before_insert",
      expectedModel: "v8",
      observedModel: "v9",
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("degrades instead of writing when the PSI daily snapshot is missing", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: null },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("psi_snapshot_missing");
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("degrades instead of writing when the PSI daily snapshot is stale", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: { ...PSI_ROW, computed_at: EXPECTED_PSI_COMPUTED_AT - 86400 } },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(result.metadata).toContain("psi_snapshot_stale");
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not seal the dataset when the published DEWS generation is missing", async () => {
    const db = mockD1([
      publishedDewsPointer(),
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: PSI_ROW },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "INSERT OR IGNORE INTO public_snapshots", rows: [] },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "public_snapshot_section_read_failed",
      missingSections: ["dews"],
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("does not seal a mixed DEWS generation while a newer chunk is staging", async () => {
    const db = mockD1([
      publishedDewsPointer(),
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: PSI_ROW },
      { match: "pharos:stress-signals:published-exact", rows: [STRESS_ROWS[1]!] },
      { match: "FROM dex_liquidity", rows: DEX_ROWS },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "public_snapshot_section_read_failed",
      missingSections: ["dews"],
      failedSections: [
        {
          section: "dews",
          error: "published generation coverage mismatch: rows=1/2",
        },
      ],
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("degrades instead of writing when the DEWS section read fails", async () => {
    const db = mockD1([
      publishedDewsPointer(),
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: PSI_ROW },
      { match: "FROM stress_signals", rows: [], throwError: new Error("D1 read failed") },
      { match: "FROM dex_liquidity", rows: DEX_ROWS },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "public_snapshot_section_read_failed",
      missingSections: ["dews"],
      failedSections: [{ section: "dews", error: "generation-read-failed:D1 read failed" }],
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });

  it("degrades instead of writing when the DEX liquidity section read fails", async () => {
    const db = mockD1([
      publishedDewsPointer(),
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: NOW_SEC },
          { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: NOW_SEC },
        ],
      },
      { match: "FROM stability_index", rows: [], first: PSI_ROW },
      { match: "FROM stress_signals", rows: STRESS_ROWS },
      { match: "FROM dex_liquidity", rows: [], throwError: new Error("D1 liquidity read failed") },
    ]);

    const result = await snapshotPublicDataset(db);

    expect(result.status).toBe("degraded");
    expect(JSON.parse(String(result.metadata))).toMatchObject({
      reason: "public_snapshot_section_read_failed",
      missingSections: ["liquidity"],
      failedSections: [{ section: "liquidity", error: "D1 liquidity read failed" }],
    });
    expect(getInsertBinds(db)).toBeUndefined();
  });
});
