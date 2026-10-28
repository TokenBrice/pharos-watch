import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { makeFlowHourlyRow } from "./mint-burn-flows.test-support";
import { perCoinFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getMintBurnConfigsForStablecoin } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../lib/mint-burn-pipeline/sync-state";

const fixtures = createLatestSchemaFixtureTracker();

// ---------------------------------------------------------------------------
// Contract tests (handler-level, using D1 mock)
// ---------------------------------------------------------------------------

describe("handleMintBurnFlows contract tests", () => {
  afterEach(() => {
    fixtures.closeAll();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const nowSec = Math.floor(Date.now() / 1000);

  let db: D1Database;
  beforeEach(() => {
    db = mintBurnScenario({ nowSec, rows: { hourly: [makeFlowHourlyRow(nowSec)] } });
  });

  it("aggregate mode returns shape matching MintBurnFlowsResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows");
    const res = await handleMintBurnFlows(db, url);

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;

    // Cross-validate against the same Zod schema the frontend uses
    const parsed = MintBurnFlowsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions
    expect(body).toHaveProperty("gauge");
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("hourly");
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body).not.toHaveProperty("stablecoinId");
  });

  it("per-coin mode returns shape matching MintBurnPerCoinResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether");
    const res = await handleMintBurnFlows(db, url);

    const body = await readJsonResponse(res, 200);

    // Cross-validate against per-coin schema
    const parsed = MintBurnPerCoinResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions — NOT aggregate shape
    expect(body).toHaveProperty("stablecoinId");
    expect(body).toHaveProperty("chains");
    expect(body).not.toHaveProperty("coins");
    expect(body).not.toHaveProperty("gauge");
  });

  it.each(["busd0-usual", "tbill-openeden"])("retains detail history for quarantined configured coin %s", async (id) => {
    const response = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?stablecoin=${id}`));
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.stablecoinId).toBe(id);
    expect(body.publication?.legs.every((leg) => leg.status === "admitted")).toBe(true);
  });

  it.each(["busd0-usual", "tbill-openeden"])("keeps disabled %s detail available without exposing stored hourly values", async (id) => {
    const { sqlite, db } = fixtures.open();
    const configs = getMintBurnConfigsForStablecoin(id);
    sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
      mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
      VALUES (?, ?, ?, 1, 0, 0, 0, 1000000, 0, 1000000)`)
      .run(id, configs[0].chain.chainId, Math.floor(nowSec / 3600) * 3600 - 3600);
    sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
      .run(JSON.stringify(configs.map(mintBurnConfigKey)), nowSec);
    const response = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?stablecoin=${id}`));
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body).toMatchObject({ stablecoinId: id, netFlowUsd: null, mintVolumeUsd: 0, chains: [], hourly: [],
      scanCoverage: { complete: false } });
    expect(body.publication?.legs.every((leg) => leg.status === "disabled")).toBe(true);
  });

  it("serves the last valid per-coin cache when the initial admission context read fails", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether");
    const value = await (await handleMintBurnFlows(db, url)).text();
    const fallbackDb = mintBurnScenario({ nowSec,
      flowCache: { key: perCoinFlowCacheKey("usdt-tether", 24), value, updatedAt: nowSec },
      overrides: [{ match: "pharos:mint-burn-scan-coverage:read", rows: [], throwError: new Error("D1 overloaded") }],
    });
    const response = await handleMintBurnFlows(fallbackDb, url);
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.stablecoinId).toBe("usdt-tether");
  });

  it("retains the producer's declared unavailable reason through the authoritative shared DTO", async () => {
    const unavailableDb = mintBurnScenario({ rows: { scanCoverage: [] } });
    const body = MintBurnFlowsResponseSchema.parse(await readJsonResponse(
      await handleMintBurnFlows(unavailableDb, new URL("https://x/api/mint-burn-flows")), 200));
    expect(body.coins.length).toBeGreaterThan(0);
    for (const coin of body.coins) {
      expect(coin.coverage?.unavailableReason).toBe("scan-coverage-incomplete");
      for (const window of Object.values(coin.coverage?.windows ?? {})) {
        expect(window).toEqual({ complete: false, unavailableReason: "scan-coverage-incomplete" });
      }
      expect(coin.has24hActivity).toBeNull();
      expect(coin.totalsSemantics).toBe("observed-subtotals");
    }
  });

  registerStablecoinParameterContract({
    name: "mint/burn flows",
    path: "/api/mint-burn-flows",
    invoke: handleMintBurnFlows,
    cases: [{ kind: "unknown", stablecoin: "99999" }],
  });

  it("returns 404 for a valid stablecoin that is not tracked for mint/burn flows", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=susdai-usd-ai");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Stablecoin "susdai-usd-ai" is not tracked for mint/burn flows',
    });
  });

  it("rejects out-of-range hours instead of clamping them", async () => {
    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=9999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid hours: must be between 1 and 720" });
  });

  it("returns 503 when stablecoins cache is unavailable and no flow fallback cache exists", async () => {
    const res = await handleMintBurnFlows(
      mintBurnScenario({ stablecoinsCache: null }),
      new URL("https://x/api/mint-burn-flows"),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Stablecoins data not yet available",
    });
  });
});
