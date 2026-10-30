import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { makeFlowHourlyRow } from "./mint-burn-flows.test-support";
import { aggregateFlowCacheKey, perCoinFlowCacheKey } from "../../lib/mint-burn-flow-cache-keys";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getMintBurnConfigsForStablecoin } from "../../lib/mint-burn-contracts";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanFingerprint } from "../../lib/mint-burn-pipeline/scan-coverage";
import { isGrandfatheredMintBurnConfig, syncMintBurnPublicationPolicy } from "../../lib/mint-burn-publication";
import { detectFlightToQualityFromValuedNets } from "../../lib/mint-burn-scoring";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";
import { ACTIVE_MINT_BURN_CONFIGS } from "../mint-burn-flows/aggregate";
import { handleMintBurnEvents } from "../mint-burn-events";
import type { MockD1Database } from "@shared/test-utils/mock-d1";

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
    expect(parsed.data?.publication).toMatchObject({ legsScope: "non-admitted", admittedCount: 135, pendingAdmissionCount: 2 });
    expect(parsed.data?.publication?.legs.every((leg) => leg.status !== "admitted")).toBe(true);
    const cached = (db as MockD1Database).getHistory().find((entry) => entry.sql.includes("INSERT INTO cache")
      && entry.binds[0] === aggregateFlowCacheKey(24));
    expect(JSON.parse(String(cached?.binds[1])).publication).toEqual(body.publication);
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

  it.each(["tbill-openeden"])("retains quarantined %s history after the cron policy write", async (id) => {
    const { db, sqlite } = fixtures.open();
    const config = getMintBurnConfigsForStablecoin(id)[0];
    const hour = Math.floor(nowSec / 3600) * 3600 - 3600;
    sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
      mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
      VALUES (?, 'ethereum', ?, 1, 0, 0, 0, 1000000, 0, 1000000)`).run(id, hour);
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, tx_hash, block_number, explorer_tx_url)
      VALUES ('historical', ?, ?, 'ethereum', 'mint', 1000000, 1000000, ?,
        'standard', '0xtest', 1, 'https://example.com')`).run(id, config.symbol, hour);
    await syncMintBurnPublicationPolicy(db, [], nowSec, ACTIVE_MINT_BURN_CONFIGS.map(mintBurnConfigKey));
    expect(sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy WHERE id = 1").get())
      .toEqual({ paused_keys: "[]" });
    const response = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?stablecoin=${id}`));
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.stablecoinId).toBe(id);
    expect(body.chains.map((chain) => chain.chainId)).toEqual(["ethereum"]);
    expect(body.mintCount).toBe(1);
    expect(body.publication).toMatchObject({ admittedCount: 1, legs: [] });
    const events = await readJsonResponse(await handleMintBurnEvents(db,
      new URL(`https://x/api/mint-burn-events?stablecoin=${id}`)), 200);
    expect(events).toMatchObject({ total: 1, events: [expect.objectContaining({ id: "historical" })] });
  });

  it.each(["tbill-openeden"])("keeps disabled %s detail available without exposing stored hourly values", async (id) => {
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

// ---------------------------------------------------------------------------
// Flight-to-quality cohort completeness
// ---------------------------------------------------------------------------

const ftqRoster = [...ACTIVE_MINT_BURN_CONFIGS];
const ftqSafeConfig = ftqRoster.find((config) => config.stablecoinId === "usdc-circle" && config.chain.chainId === "ethereum")!;
const ftqRiskyConfig = ftqRoster.find((config) => config.stablecoinId === "dai-makerdao" && config.chain.chainId === "ethereum")!;
// swanUSD's only configured leg is reviewed but has no durable 90-day baseline, so it
// publishes as `pending-admission` and never enters `data.configs`.
const ftqUnadmittedConfig = ftqRoster.find((config) => config.stablecoinId === "swanusd-swan")!;

describe("aggregate flight-to-quality cohorts", () => {
  const HOUR = 3_600;
  const DAY = 86_400;
  const end = Date.parse("2027-02-01T12:00:00Z") / 1000;

  beforeEach(() => {
    ACTIVE_MINT_BURN_CONFIGS.splice(0, ACTIVE_MINT_BURN_CONFIGS.length, ftqSafeConfig, ftqRiskyConfig, ftqUnadmittedConfig);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((end + 60) * 1000);
  });

  afterEach(() => {
    ACTIVE_MINT_BURN_CONFIGS.splice(0, ACTIVE_MINT_BURN_CONFIGS.length, ...ftqRoster);
    fixtures.closeAll();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("withholds the inactive verdict while a graded risky coin has no admitted 24h flow", async () => {
    expect(isGrandfatheredMintBurnConfig(ftqSafeConfig)).toBe(true);
    expect(isGrandfatheredMintBurnConfig(ftqRiskyConfig)).toBe(true);
    expect(isGrandfatheredMintBurnConfig(ftqUnadmittedConfig)).toBe(false);

    const { sqlite, db } = fixtures.open();
    for (const [config, historyDays] of [[ftqSafeConfig, 90], [ftqRiskyConfig, 90], [ftqUnadmittedConfig, 31]] as const) {
      const toBlock = config.startBlock + 3_000_000;
      await upsertMintBurnSyncState(db, mintBurnConfigKey(config), toBlock, "monotonic-max", {
        configKey: mintBurnConfigKey(config),
        configFingerprint: mintBurnScanFingerprint(config),
        chainId: config.chain.chainId,
        fromBlock: config.startBlock,
        toBlock,
        fromTimestamp: end - historyDays * DAY,
        toTimestamp: end,
        finalizedBlock: toBlock,
        acceptedAt: end,
      });
    }
    const hourly = sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd,
       mint_unpriced_event_count, burn_unpriced_event_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`);
    // Observed safe inflow is already past the +$100M activation threshold.
    hourly.run("usdc-circle", "ethereum", end - HOUR, 1, 0, 150_000_000, 0, 150_000_000);
    // The observed risky outflow is short of -$100M; the omitted risky coin is unbounded.
    hourly.run("dai-makerdao", "ethereum", end - HOUR, 0, 1, 0, 20_000_000, -20_000_000);
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run("stablecoins", JSON.stringify({
      peggedAssets: [
        { id: "usdc-circle", symbol: "USDC", circulating: { peggedUSD: 60_000_000_000 }, chainCirculating: { Ethereum: { current: 60_000_000_000 } } },
        { id: "dai-makerdao", symbol: "DAI", circulating: { peggedUSD: 4_000_000_000 }, chainCirculating: { Ethereum: { current: 4_000_000_000 } } },
      ],
    }), end);

    const snapshot = makeWorkerReportCardsV9Response({
      updatedAt: end + 60,
      cards: [
        makeWorkerV9Card({ id: "usdc-circle", score: 82, grade: "A" }),
        makeWorkerV9Card({ id: "dai-makerdao", score: 30, grade: "D" }),
        // Rated risky, so it belongs in the risky cohort with an unknown net.
        makeWorkerV9Card({ id: "swanusd-swan", score: 28, grade: "D" }),
      ],
    });
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue({ kind: "v9", snapshot });

    const response = await handleMintBurnFlows(db, new URL("https://api.test/api/mint-burn-flows"));
    const body = MintBurnFlowsResponseSchema.parse(await response.json());

    // Reachability: the risky coin's only leg is published as pending admission.
    expect(body.publication).toMatchObject({ pendingAdmissionCount: 1 });
    expect(body.publication?.legs).toContainEqual(expect.objectContaining({
      stablecoinId: "swanusd-swan", chainId: "ethereum", status: "pending-admission",
    }));
    expect(body.coins.map((coin) => coin.stablecoinId).sort()).toEqual(["dai-makerdao", "usdc-circle"]);

    const usdc = body.coins.find((coin) => coin.stablecoinId === "usdc-circle")!;
    const dai = body.coins.find((coin) => coin.stablecoinId === "dai-makerdao")!;
    expect(usdc.valuation?.window24h.completeness).toBe("complete");
    expect(dai.valuation?.window24h.completeness).toBe("complete");
    expect(usdc.netFlow24hUsd).toBe(150_000_000);
    expect(dai.netFlow24hUsd).toBe(-20_000_000);

    // Ground truth: the same observed nets cannot support an inactive verdict once
    // the omitted graded coin is carried as an unbounded cohort member.
    expect(detectFlightToQualityFromValuedNets({
      safe: [{ knownNetUsd: 150_000_000, valuation: { mintCompleteness: "complete", burnCompleteness: "complete" } }],
      risky: [
        { knownNetUsd: -20_000_000, valuation: { mintCompleteness: "complete", burnCompleteness: "complete" } },
        { knownNetUsd: null, valuation: { mintCompleteness: "unknown", burnCompleteness: "unknown" } },
      ],
    })).toBeNull();

    // The omitted risky coin's outflow is unknown, so activation cannot be ruled out.
    expect(body.gauge.flightToQuality).toBeNull();
  });
});
