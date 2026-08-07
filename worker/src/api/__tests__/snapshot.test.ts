import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { handleSnapshotCoin, handleSnapshotDay, handleSnapshotsIndex } from "../snapshot";

const ISO_DATE = "2026-05-16";
const V8_SAFETY_SCORE_IDENTITY = ({
  model: "v8" as const,
  schemaVersion: 1 as const,
  evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
  methodologyVersion: "7.25",
  baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
  publicationGenerationId: "report-cards:7.25:1779105600",
});

const SAMPLE_ENVELOPE = {
  snapshotDate: ISO_DATE,
  generatedAt: 1779105600,
  methodologyVersions: {
    pegScore: "7.25",
    dews: "6.0",
    liquidityScore: "1.0",
    psi: "3.3",
    reportCard: "7.25",
    chainHealth: "1.2",
    redemptionBackstop: "1.0",
    pricingPipeline: "1.0",
    yieldMethodology: "1.0",
  },
  safetyScoreIdentity: V8_SAFETY_SCORE_IDENTITY,
  stablecoins: [
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
  reportCards: {
    methodologyVersion: "7.25",
    scores: {
      "usdc-circle": { score: 92.4, grade: "A-" },
    },
    updatedAt: 1779105600,
    safetyScoreIdentity: V8_SAFETY_SCORE_IDENTITY,
    publicationGenerationId: V8_SAFETY_SCORE_IDENTITY.publicationGenerationId,
    completeness: {
      generationId: V8_SAFETY_SCORE_IDENTITY.publicationGenerationId,
      methodologyVersion: "7.25",
      expectedCount: 2,
      scoredCount: 1,
      notRatedCount: 1,
      notRatedIds: ["usdt-tether"],
    },
  },
  psi: {
    computedAt: 1779062400,
    score: 87.4,
    band: "STEADY",
    components: { severity: 5, breadth: 2, stressBreadth: 1, trend: 0.5 },
    methodologyVersion: "3.3",
  },
  dews: [
    {
      stablecoinId: "usdc-circle",
      computedAt: 1779105000,
      score: 18,
      band: "CALM",
      signals: { delta: 0.04 },
    },
  ],
  liquidity: [
    {
      stablecoinId: "usdc-circle",
      totalTvlUsd: 1_500_000_000,
      totalVolume24hUsd: 800_000_000,
      poolCount: 124,
      liquidityScore: 9.2,
      durabilityScore: 8.6,
      coverageClass: "deep",
      updatedAt: 1779105600,
    },
  ],
};

const V9_SAFETY_SCORE_IDENTITY = {
  model: "v9",
  schemaVersion: 1,
  methodologyVersion: "9.0",
  policyId: "v9-policy-2026-05",
  policyDigest: "b".repeat(64),
  evaluationBuildDigest: "c".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
  publicationGenerationId: "safety-score-v9:9.0:1779105600",
} satisfies SafetyScorePublicationIdentity;

type SnapshotEnvelope = Omit<typeof SAMPLE_ENVELOPE, "safetyScoreIdentity" | "reportCards"> & {
  safetyScoreIdentity?: SafetyScorePublicationIdentity;
  reportCards: unknown;
};

async function gzipText(value: string): Promise<Uint8Array> {
  const stream = new Response(new TextEncoder().encode(value)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildSnapshotRow(
  envelope: SnapshotEnvelope = SAMPLE_ENVELOPE,
  options: { includeMetadataIdentity?: boolean } = {},
) {
  const jsonText = JSON.stringify(envelope);
  return {
    snapshot_date: envelope.snapshotDate,
    payload_gz: await gzipText(jsonText),
    methodology_versions: JSON.stringify({
      ...envelope.methodologyVersions,
      ...(options.includeMetadataIdentity === false
        ? {}
        : { safetyScoreIdentity: envelope.safetyScoreIdentity }),
    }),
    content_hash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    byte_size: new TextEncoder().encode(jsonText).byteLength,
    created_at: 1779105600,
  };
}

describe("handleSnapshotsIndex", () => {
  it("returns an empty list when no snapshots exist", async () => {
    const db = mockD1([{ match: "FROM public_snapshots", rows: [] }]);
    const res = await handleSnapshotsIndex(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { snapshots: unknown[] };
    expect(body.snapshots).toEqual([]);
  });

  it("returns parsed entries sorted by snapshot_date desc", async () => {
    const db = mockD1([
      {
        match: "FROM public_snapshots",
        rows: [
          {
            snapshot_date: "2026-05-16",
            methodology_versions: JSON.stringify({ pegScore: "7.25" }),
            content_hash: "hash1",
            byte_size: 12345,
            created_at: 1779105600,
          },
          {
            snapshot_date: "2026-05-15",
            methodology_versions: JSON.stringify({ pegScore: "7.25" }),
            content_hash: "hash2",
            byte_size: 12000,
            created_at: 1779019200,
          },
        ],
      },
    ]);
    const res = await handleSnapshotsIndex(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      snapshots: {
        snapshotDate: string;
        contentHash: string;
        methodologyVersions: { pegScore: string };
        safetyScoreIdentity: { model: string } | null;
      }[];
    };
    expect(body.snapshots).toHaveLength(2);
    expect(body.snapshots[0]?.snapshotDate).toBe("2026-05-16");
    expect(body.snapshots[0]?.contentHash).toBe("hash1");
    expect(body.snapshots[0]?.methodologyVersions.pegScore).toBe("7.25");
    expect(body.snapshots[0]?.safetyScoreIdentity).toBeNull();
  });

  it("exposes the immutable snapshot safety identity from publication metadata", async () => {
    const row = await buildSnapshotRow();
    const db = mockD1([{ match: "FROM public_snapshots", rows: [row] }]);

    const res = await handleSnapshotsIndex(db);
    const body = (await res.json()) as { snapshots: Array<{ safetyScoreIdentity: { model: string } | null }> };

    expect(body.snapshots[0]?.safetyScoreIdentity).toMatchObject({ model: "v8" });
  });

  it("preserves a valid V9 identity in snapshot index and coin responses", async () => {
    const cards = [
      makeWorkerV9Card({ id: "usdc-circle", score: 92, grade: "A+" }),
      makeWorkerV9Card({ id: "usdt-tether", score: 81, grade: "A-" }),
    ];
    const row = await buildSnapshotRow({
      ...SAMPLE_ENVELOPE,
      methodologyVersions: {
        ...SAMPLE_ENVELOPE.methodologyVersions,
        reportCard: V9_SAFETY_SCORE_IDENTITY.methodologyVersion,
      },
      safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
      reportCards: makeWorkerReportCardsV9Response({
        lifecycle: "active",
        safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
        asOfSec: 1779105500,
        updatedAt: 1779105600,
        cards,
      }),
    });
    const indexDb = mockD1([{ match: "FROM public_snapshots", rows: [row] }]);

    const indexResponse = await handleSnapshotsIndex(indexDb);
    const indexBody = (await indexResponse.json()) as {
      snapshots: Array<{ safetyScoreIdentity: unknown }>;
    };

    expect(indexBody.snapshots[0]?.safetyScoreIdentity).toEqual(V9_SAFETY_SCORE_IDENTITY);

    const coinDb = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const coinResponse = await handleSnapshotCoin(coinDb, ISO_DATE, "usdc-circle");
    const coinBody = (await coinResponse.json()) as { safetyScoreIdentity: unknown };

    expect(coinBody.safetyScoreIdentity).toEqual(V9_SAFETY_SCORE_IDENTITY);
  });

  it("keeps retained report-v2 and trace-v2 V9 snapshots readable", async () => {
    const retainedReport = structuredClone(
      makeWorkerReportCardsV9Response({
        lifecycle: "active",
        safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
        asOfSec: 1779105500,
        updatedAt: 1779105600,
        cards: [makeWorkerV9Card({ id: "usdt-tether", score: 83, grade: "A" })],
      }),
    ) as unknown as {
      schemaVersion: number;
      publicationHealth?: unknown;
      cards: Array<{ breakdowns?: unknown; scoreTrace: Record<string, unknown> }>;
    };
    retainedReport.schemaVersion = 2;
    delete retainedReport.publicationHealth;
    delete retainedReport.cards[0]!.breakdowns;
    retainedReport.cards[0]!.scoreTrace.schemaVersion = 2;
    delete retainedReport.cards[0]!.scoreTrace.scoreAdjustments;
    const row = await buildSnapshotRow({
      ...SAMPLE_ENVELOPE,
      methodologyVersions: {
        ...SAMPLE_ENVELOPE.methodologyVersions,
        reportCard: V9_SAFETY_SCORE_IDENTITY.methodologyVersion,
      },
      safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
      reportCards: retainedReport,
    });

    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const response = await handleSnapshotCoin(db, ISO_DATE, "usdt-tether");
    const body = (await response.json()) as { safetyScoreIdentity: unknown };

    expect(response.status).toBe(200);
    expect(body.safetyScoreIdentity).toEqual(V9_SAFETY_SCORE_IDENTITY);
  });

  it.each(["2026-07-13", "2026-07-14", "2026-07-15"])(
    "keeps the %s partial-identity transition readable without claiming a verified identity",
    async (transitionDate) => {
      const {
        safetyScoreIdentity: _omittedIdentity,
        ...transitionalEnvelope
      } = {
        ...SAMPLE_ENVELOPE,
        snapshotDate: transitionDate,
      };
      const row = await buildSnapshotRow(transitionalEnvelope, {
        includeMetadataIdentity: false,
      });
      const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);

      const response = await handleSnapshotCoin(db, transitionDate, "usdc-circle");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        safetyScoreIdentity: unknown;
        scores: { reportCard: { grade: string } | null };
      };
      expect(body.safetyScoreIdentity).toBeNull();
      expect(body.scores.reportCard?.grade).toBe("A-");
    },
  );
});

describe("handleSnapshotDay", () => {
  it("returns 400 for malformed date", async () => {
    const db = mockD1();
    const res = await handleSnapshotDay(db, "not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 404 when no row exists for the date", async () => {
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: null }]);
    const res = await handleSnapshotDay(db, ISO_DATE);
    expect(res.status).toBe(404);
  });

  it("returns the decompressed JSON envelope with the immutable cache header", async () => {
    const row = await buildSnapshotRow();
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const res = await handleSnapshotDay(db, ISO_DATE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=31536000, max-age=31536000, immutable",
    );
    const body = (await res.json()) as { snapshotDate: string; stablecoins: { id: string }[] };
    expect(body.snapshotDate).toBe(ISO_DATE);
    expect(body.stablecoins.map((c) => c.id).sort()).toEqual(["usdc-circle", "usdt-tether"]);
    expect(res.headers.get("etag")).toBe(`"${row.content_hash}"`);
  });

  it("rejects an identified snapshot whose completeness does not match its cards", async () => {
    const row = await buildSnapshotRow({
      ...SAMPLE_ENVELOPE,
      reportCards: {
        ...SAMPLE_ENVELOPE.reportCards,
        completeness: {
          ...SAMPLE_ENVELOPE.reportCards.completeness,
          scoredCount: 2,
          notRatedCount: 0,
          notRatedIds: [],
        },
      },
    });
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);

    const response = await handleSnapshotDay(db, ISO_DATE);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "Snapshot safety identity corrupted",
    });
  });

  it("rejects an identified snapshot whose embedded card identity diverges", async () => {
    const row = await buildSnapshotRow({
      ...SAMPLE_ENVELOPE,
      reportCards: {
        ...SAMPLE_ENVELOPE.reportCards,
        safetyScoreIdentity: {
          ...V8_SAFETY_SCORE_IDENTITY,
          publicationGenerationId: "report-cards:7.25:other",
        },
      },
    });
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);

    const response = await handleSnapshotDay(db, ISO_DATE);
    expect(response.status).toBe(500);
  });

  it("rejects an identity-less snapshot after the bounded transition window", async () => {
    const snapshotDate = "2026-07-16";
    const {
      safetyScoreIdentity: _outerIdentity,
      ...identityLessEnvelope
    } = {
      ...SAMPLE_ENVELOPE,
      snapshotDate,
      reportCards: {
        scores: SAMPLE_ENVELOPE.reportCards.scores,
        updatedAt: SAMPLE_ENVELOPE.reportCards.updatedAt,
      },
    };
    const row = await buildSnapshotRow(identityLessEnvelope, {
      includeMetadataIdentity: false,
    });
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);

    const response = await handleSnapshotDay(db, snapshotDate);
    expect(response.status).toBe(500);
  });

  it("rejects a V9 snapshot whose completeness diverges from its native cards", async () => {
    const cards = [
      makeWorkerV9Card({ id: "usdc-circle" }),
      makeWorkerV9Card({ id: "usdt-tether" }),
    ];
    const validV9 = makeWorkerReportCardsV9Response({
      lifecycle: "active",
      safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
      asOfSec: 1779105500,
      updatedAt: 1779105600,
      cards,
    });
    const row = await buildSnapshotRow({
      ...SAMPLE_ENVELOPE,
      methodologyVersions: {
        ...SAMPLE_ENVELOPE.methodologyVersions,
        reportCard: V9_SAFETY_SCORE_IDENTITY.methodologyVersion,
      },
      safetyScoreIdentity: V9_SAFETY_SCORE_IDENTITY,
      reportCards: {
        ...validV9,
        completeness: {
          ...validV9.completeness,
          expectedCount: 3,
        },
      },
    });
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);

    const response = await handleSnapshotDay(db, ISO_DATE);
    expect(response.status).toBe(500);
  });
});

describe("handleSnapshotCoin", () => {
  it("returns 400 for malformed date", async () => {
    const db = mockD1();
    const res = await handleSnapshotCoin(db, "bad", "usdc-circle");
    expect(res.status).toBe(400);
  });

  it("returns 404 when no row exists for the date", async () => {
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: null }]);
    const res = await handleSnapshotCoin(db, ISO_DATE, "usdc-circle");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the snapshot exists but the coin is absent", async () => {
    const row = await buildSnapshotRow();
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const res = await handleSnapshotCoin(db, ISO_DATE, "nonexistent-coin");
    expect(res.status).toBe(404);
  });

  it("projects a single coin out of the snapshot with attached scores", async () => {
    const row = await buildSnapshotRow();
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const res = await handleSnapshotCoin(db, ISO_DATE, "usdc-circle");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "public, s-maxage=31536000, max-age=31536000, immutable",
    );
    const body = (await res.json()) as {
      snapshotDate: string;
      stablecoinId: string;
      methodologyVersions: { pegScore: string };
      safetyScoreIdentity: { model: string } | null;
      stablecoin: { id: string; symbol: string };
      scores: {
        reportCard: { score: number; grade: string } | null;
        psi: { score: number; band: string } | null;
        dews: { stablecoinId: string; score: number } | null;
        liquidity: { stablecoinId: string; liquidityScore: number } | null;
      };
    };
    expect(body.snapshotDate).toBe(ISO_DATE);
    expect(body.stablecoinId).toBe("usdc-circle");
    expect(body.stablecoin.id).toBe("usdc-circle");
    expect(body.methodologyVersions.pegScore).toBe("7.25");
    expect(body.safetyScoreIdentity).toMatchObject({ model: "v8" });
    expect(body.scores.reportCard?.grade).toBe("A-");
    expect(body.scores.psi?.score).toBe(87.4);
    expect(body.scores.dews?.stablecoinId).toBe("usdc-circle");
    expect(body.scores.liquidity?.liquidityScore).toBe(9.2);
  });

  it("returns null score fields for a coin without per-coin score rows in the envelope", async () => {
    const row = await buildSnapshotRow();
    const db = mockD1([{ match: "FROM public_snapshots", rows: [], first: row }]);
    const res = await handleSnapshotCoin(db, ISO_DATE, "usdt-tether");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stablecoinId: string;
      scores: {
        reportCard: unknown;
        dews: unknown;
        liquidity: unknown;
      };
    };
    expect(body.stablecoinId).toBe("usdt-tether");
    expect(body.scores.reportCard).toBeNull();
    expect(body.scores.dews).toBeNull();
    expect(body.scores.liquidity).toBeNull();
  });
});
