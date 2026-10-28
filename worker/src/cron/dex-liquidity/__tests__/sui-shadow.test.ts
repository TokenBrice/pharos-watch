import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPEG_PRIMARY_PRICE_MAX_AGE_SEC } from "@shared/lib/depeg-config";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { SuiClmmShadowHistorySchema } from "@shared/types/sui-clmm";
import { compactCronMetadataForPersistence } from "../../../lib/cron-metadata-persistence";
import { collectSuiClmmShadowQuotes } from "../sui/shadow";
import * as stateReader from "../sui/state-reader";
import * as independentQuote from "../sui/independent-quote";
import fixtures from "./fixtures/sui-clmm-checkpoints.json";

const usdy = fixtures.fixtures[0];
const buck = fixtures.fixtures[3];
const nowSec = Math.floor(Number(usdy.capture.checkpoint.timestampMs) / 1000);
const rows = [
  { pool_id: usdy.poolId, stablecoin_id: "usdy-ondo-finance", tvl_usd: 200_000, project: "cetus" },
  { pool_id: buck.poolId, stablecoin_id: "buck-bucket-protocol", tvl_usd: 100_000, project: "cetus" },
];
const env = { DWELLIR_API_KEY: "test-header-only-key" };

function asset(id: string, overrides: Record<string, unknown> = {}) {
  return { id, name: id, symbol: id, pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: id === "usdy-ondo-finance" ? 1.15 : 0.997, priceSource: "coingecko", priceConfidence: "single-source",
    priceObservedAt: nowSec, priceUpdatedAt: nowSec, priceObservedAtMode: "upstream",
    circulating: { peggedUSD: 1_000_000 }, chainCirculating: {}, chains: ["Sui"], ...overrides };
}

function database(assets: ReturnType<typeof asset>[] | null, selected = rows, updatedAt = nowSec) {
  return mockD1([
    { match: "FROM cache WHERE key = ?", matchBinds: ["stablecoins"], rows: assets == null ? [] : [{ value: JSON.stringify({ peggedAssets: assets }), updated_at: updatedAt }] },
    { match: "FROM cache WHERE key = ?", rows: [] },
    { match: "FROM dex_source_pagination_state", rows: [] },
    { match: "FROM dex_liquidity dl, json_each", rows: selected },
    { match: "INSERT INTO dex_source_pagination_state", rows: [], runMeta: { changes: 1 } },
    { match: "INSERT INTO cache", rows: [], runMeta: { changes: 1 } },
  ]);
}

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(nowSec * 1000));
afterEach(() => { vi.restoreAllMocks(); });

describe("Sui shadow diagnostic price preflight and reasons", () => {
  it.each(["high", "single-source"])("attempts both real retained pools with fresh %s published prices", async (confidence) => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
    const db = database(rows.map((row) => asset(row.stablecoin_id, { priceConfidence: confidence })));
    const summary = await collectSuiClmmShadowQuotes({ db, env });
    expect(summary).toMatchObject({ attempted: 2, persisted: 0, failed: 2, requests: 2, scoreEligible: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(summary.reason).toMatch(/^sui-/);
    expect(summary.reason).not.toBe("sui-trusted-input-reference-unavailable");
  });

  it.each([
    { name: "missing cache", assets: null },
    { name: "missing price", assets: [asset(rows[0].stablecoin_id, { price: null })] },
    { name: "stale observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1 })] },
    { name: "future observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: nowSec + 1 })] },
    { name: "missing observation", assets: [asset(rows[0].stablecoin_id, { priceObservedAt: null, priceUpdatedAt: null })] },
    { name: "missing source", assets: [asset(rows[0].stablecoin_id, { priceSource: null })] },
    { name: "low confidence", assets: [asset(rows[0].stablecoin_id, { priceConfidence: "low" })] },
    { name: "nominal reference", assets: [asset(rows[0].stablecoin_id, { priceSource: "protocol-par", priceObservedAtMode: "nominal_reference" })] },
  ])("rejects $name without any RPC request", async ({ assets }) => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db: database(assets, rows.slice(0, 1)), env });
    expect(summary).toMatchObject({ attempted: 1, persisted: 0, failed: 1, requests: 0,
      reason: "sui-trusted-input-reference-unavailable", lastFailureReason: "sui-trusted-input-reference-unavailable" });
    expect(summary.failures).toEqual([`${usdy.poolId}:sui-trusted-input-reference-unavailable`]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC - 1, nowSec + 1])("rejects a stale or future published cache generation (%s)", async (updatedAt) => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db: database([asset(rows[0].stablecoin_id)], rows.slice(0, 1), updatedAt), env });
    expect(summary).toMatchObject({ requests: 0, reason: "sui-trusted-input-reference-unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists diagnostic quote inputs and their source, clock, confidence and freshness budget", async () => {
    const db = database([asset(rows[0].stablecoin_id, { priceObservedAt: null, priceUpdatedAt: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC })], rows.slice(0, 1));
    vi.spyOn(stateReader, "fetchSuiClmmCapture").mockResolvedValue(usdy.capture as stateReader.SuiClmmCapture);
    const inspection = vi.spyOn(independentQuote, "inspectSuiClmmQuotes");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const summary = await collectSuiClmmShadowQuotes({ db, env });
    expect(summary).toMatchObject({ attempted: 1, persisted: 1, failed: 0, scoreEligible: false,
      independentCheckReason: "sui-grpc-inspection-unsupported" });
    expect(inspection).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    const write = db.getHistory().find(({ sql }) => sql.includes("INSERT INTO cache"));
    expect(write).toBeDefined();
    const sample = SuiClmmShadowHistorySchema.parse(JSON.parse(String(write!.binds[1]))).samples[0];
    expect(sample.inputPriceReference).toEqual({ source: "coingecko", confidence: "single-source",
      observedAtSec: nowSec - DEPEG_PRIMARY_PRICE_MAX_AGE_SEC, cacheUpdatedAtSec: nowSec, maxAgeSec: DEPEG_PRIMARY_PRICE_MAX_AGE_SEC });
    expect(sample.inputPriceUsd).toBe(1.15);
    expect(sample.quotes.length).toBeGreaterThan(0);
    expect(sample.independentCheck).toBe("failed");
    expect(sample.independentCheckReason).toBe("sui-grpc-inspection-unsupported");
    expect(sample.quotes.every((quote) => quote.independentAgreement === null)).toBe(true);
    expect(sample.scoreEligible).toBe(false);
    const historical = { ...sample, inputPriceReference: undefined };
    expect(SuiClmmShadowHistorySchema.safeParse({ schemaVersion: "sui-clmm-shadow-v1", samples: [historical] }).success).toBe(true);
  });

  it("retains bounded first/last reason codes through cron metadata compaction", async () => {
    vi.spyOn(stateReader, "fetchSuiClmmCapture")
      .mockRejectedValueOnce(new Error("sui-grpc-http-404"))
      .mockRejectedValueOnce(new Error("sui-object-unavailable"));
    const summary = await collectSuiClmmShadowQuotes({ db: database(rows.map((row) => asset(row.stablecoin_id))), env });
    expect(summary).toMatchObject({ reason: "sui-grpc-http-404", lastFailureReason: "sui-object-unavailable" });
    const compacted = compactCronMetadataForPersistence(JSON.stringify({ suiShadow: summary, payload: "x".repeat(20_000) }), undefined, "sync-cl-exit-depth");
    expect(compacted.compacted).toBe(true);
    expect(JSON.parse(compacted.metadata!).diagnostics.suiShadow).toMatchObject({ reason: "sui-grpc-http-404",
      lastFailureReason: "sui-object-unavailable", failuresCount: 2, scoreEligible: false });
  });
});
