import { describe, expect, it } from "vitest";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleSnapshotCoin, handleSnapshotDay, handleSnapshotsIndex } from "../snapshot";

const ISO_DATE = "2026-05-16";

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
  safetyScoreIdentity: buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: "7.25",
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    publicationGenerationId: "report-cards:7.25:1779105600",
  }),
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
    scores: {
      "usdc-circle": { score: 92.4, grade: "A-" },
    },
    updatedAt: 1779105600,
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

async function gzipText(value: string): Promise<Uint8Array> {
  const stream = new Response(new TextEncoder().encode(value)).body!.pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function buildSnapshotRow(envelope: typeof SAMPLE_ENVELOPE = SAMPLE_ENVELOPE) {
  const jsonText = JSON.stringify(envelope);
  return {
    snapshot_date: envelope.snapshotDate,
    payload_gz: await gzipText(jsonText),
    methodology_versions: JSON.stringify({
      ...envelope.methodologyVersions,
      safetyScoreIdentity: envelope.safetyScoreIdentity,
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
