import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../api/__tests__/helpers/mock-d1";
import { snapshotPublicDataset } from "../snapshot-public-dataset";

const ISO_DATE = "2026-05-16";

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

const REPORT_CARD_CACHE_PAYLOAD = {
  scores: {
    "usdc-circle": { score: 92.4, grade: "A-" },
    "usdt-tether": { score: 78.1, grade: "B" },
  },
  updatedAt: 1779105600,
};

const PSI_ROW = {
  computed_at: 1779062400,
  score: 87.4,
  band: "STEADY",
  components: JSON.stringify({ severity: 5, breadth: 2, stressBreadth: 1, trend: 0.5 }),
  methodology_version: "3.3",
};

const STRESS_ROWS = [
  {
    stablecoin_id: "usdc-circle",
    computed_at: 1779105000,
    score: 18,
    band: "CALM",
    signals_json: JSON.stringify({ delta: 0.04 }),
  },
  {
    stablecoin_id: "usdt-tether",
    computed_at: 1779105000,
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

const NOW_MS = new Date(`${ISO_DATE}T08:00:00Z`).getTime();

function buildDb(): MockD1Database {
  return mockD1([
    {
      match: "FROM cache WHERE key",
      rows: [
        { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: Math.floor(NOW_MS / 1000) },
        { key: "report_card_cache", value: JSON.stringify(REPORT_CARD_CACHE_PAYLOAD), updated_at: Math.floor(NOW_MS / 1000) },
      ],
    },
    { match: "FROM stability_index", rows: [], first: PSI_ROW },
    { match: "FROM stress_signals", rows: STRESS_ROWS },
    { match: "FROM dex_liquidity", rows: DEX_ROWS },
    { match: "INSERT OR REPLACE INTO public_snapshots", rows: [] },
  ]);
}

async function gunzipToText(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

function getInsertBinds(db: MockD1Database): unknown[] | undefined {
  return db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO public_snapshots"))?.binds;
}

describe("snapshotPublicDataset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws before D1 work when the cron signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("snapshot-public-dataset aborted"));
    await expect(snapshotPublicDataset(mockD1(), controller.signal)).rejects.toThrow(
      "snapshot-public-dataset aborted",
    );
  });

  it("degrades gracefully when the stablecoins cache is missing", async () => {
    const db = mockD1([{ match: "FROM cache WHERE key", rows: [] }]);
    const result = await snapshotPublicDataset(db);
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(result.metadata).toContain("stablecoins_cache_unavailable");

    const insert = db
      .getHistory()
      .find((entry) => entry.sql.includes("INSERT OR REPLACE INTO public_snapshots"));
    expect(insert).toBeUndefined();
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
    expect(binds?.[5]).toBe(Math.floor(NOW_MS / 1000));

    const methodologyVersionsStr = binds?.[2] as string;
    const methodologyVersions = JSON.parse(methodologyVersionsStr) as Record<string, string>;
    expect(methodologyVersions).toHaveProperty("pegScore");
    expect(methodologyVersions).toHaveProperty("dews");
    expect(methodologyVersions).toHaveProperty("psi");
    expect(methodologyVersions).toHaveProperty("liquidityScore");
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
    expect(envelope.generatedAt).toBe(Math.floor(NOW_MS / 1000));
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

  it("still writes a snapshot when PSI / DEWS / liquidity rows are missing", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key",
        rows: [
          { key: "stablecoins", value: JSON.stringify(STABLECOINS_CACHE_PAYLOAD), updated_at: Math.floor(NOW_MS / 1000) },
        ],
      },
      { match: "FROM stability_index", rows: [], first: null },
      { match: "FROM stress_signals", rows: [] },
      { match: "FROM dex_liquidity", rows: [] },
      { match: "INSERT OR REPLACE INTO public_snapshots", rows: [] },
    ]);

    const result = await snapshotPublicDataset(db);
    expect(result.itemCount).toBe(1);

    const binds = getInsertBinds(db);
    const decompressed = await gunzipToText(binds?.[1] as Uint8Array);
    const envelope = JSON.parse(decompressed) as {
      psi: unknown;
      dews: unknown[];
      liquidity: unknown[];
      reportCards: unknown;
    };
    expect(envelope.psi).toBeNull();
    expect(envelope.dews).toEqual([]);
    expect(envelope.liquidity).toEqual([]);
    expect(envelope.reportCards).toBeNull();
  });
});
