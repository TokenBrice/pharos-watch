import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SolanaModule from "../../reserve-adapters/solana";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getDexExecutionCapabilityRegistration, isDexExecutionProfileAdmittedForScoring } from "@shared/lib/p4-exit-route-capability-policy";
import { buildRegisteredDirectApiExecutionTarget } from "../process-pool-execution-capability";
import { buildMeteoraDlmmRegisteredExecutionTarget } from "../execution-targets/meteora-dlmm";
import type { DexExecutionTargetFactoryInput } from "../execution-target-registry";
import { collectDlmmShadowQuotes } from "../solana/dlmm-shadow";
import { fetchSolanaAccountBatch } from "../../reserve-adapters/solana";
import { capturedDlmmAccounts, dlmmCaptures } from "./dlmm-test-support";

vi.mock("../orchestrator-phases/lookups", () => ({ loadTrackedStablecoinMaps: vi.fn(async () => ({ stablecoinPriceById: new Map([["jupusd-jupiter", 1]]) })) }));
vi.mock("../../reserve-adapters/solana", async (original) => ({ ...await original<typeof SolanaModule>(), fetchSolanaAccountBatch: vi.fn() }));
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.resetAllMocks(); });
const capture = dlmmCaptures[0];

function seedRetainedPool() {
  const opened = fixtures.open();
  const now = Math.floor(Date.now() / 1000);
  opened.sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state, top_pools_json)
    VALUES ('jupusd-jupiter', 'JUPUSD', ?, 'dlmm-fixture', 'published', ?)`)
    .run(now, JSON.stringify([{ poolId: `solana:${capture.poolAddress}`, project: "meteora", chain: "solana", poolType: "cg-amm", tvlUsd: 3_868_504 }]));
  opened.sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
    VALUES ('__global__', 'GLOBAL', ?, 'dlmm-fixture', 'published')`).run(now);
  return opened;
}

describe("DLMM retained-pool shadow collection", () => {
  it("quotes real cg-amm DLMM identity serially, retains successes and never publishes a partial-fill or score route", async () => {
    const { db, sqlite } = seedRetainedPool();
    const accounts = capturedDlmmAccounts(capture);
    let active = 0;
    let peak = 0;
    vi.mocked(fetchSolanaAccountBatch).mockImplementation(async (addresses) => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      const response = { slot: capture.slot, accounts: new Map(addresses.map((address) => [address, accounts.get(address) ?? null])) };
      active--;
      return response;
    });
    const summary = await collectDlmmShadowQuotes({ db });
    expect(summary).toMatchObject({ attempted: 1, persisted: 3, failed: 2, scoreEligible: false });
    expect(peak).toBe(1);
    const rows = sqlite.prepare("SELECT notional_usd, amount_out, slot, score_eligible, profile_id FROM dex_meteora_dlmm_shadow_quotes ORDER BY notional_usd").all();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ notional_usd: 1000, amount_out: "999405330", slot: capture.slot, score_eligible: 0, profile_id: "meteora-dlmm-exact-v1" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_measured_execution_quotes").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_measured_execution_targets").get()).toEqual({ n: 0 });
    await collectDlmmShadowQuotes({ db });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_meteora_dlmm_shadow_quotes").get()).toEqual({ n: 3 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2").get()).toEqual({ n: 0 });
    expect(() => sqlite.prepare("UPDATE dex_meteora_dlmm_shadow_quotes SET score_eligible = 1").run()).toThrow();
  });

  it("bounds the isolated seven-day retention drain without touching current quotes", async () => {
    const { db, sqlite } = seedRetainedPool();
    const accounts = capturedDlmmAccounts(capture);
    vi.mocked(fetchSolanaAccountBatch).mockImplementation(async (addresses) => ({
      slot: capture.slot, accounts: new Map(addresses.map((address) => [address, accounts.get(address) ?? null])),
    }));
    await collectDlmmShadowQuotes({ db });
    const copy = sqlite.prepare(`INSERT INTO dex_meteora_dlmm_shadow_quotes
      SELECT ?, stablecoin_id, slot, ?, notional_usd, token_mint_in, token_mint_out, amount_in, amount_out,
        input_price_usd, input_decimals, model_version, profile_id, capability_id, score_eligible
      FROM dex_meteora_dlmm_shadow_quotes WHERE notional_usd = 1000 LIMIT 1`);
    const expiredAt = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60 - 1;
    for (let i = 0; i < 300; i++) copy.run(`expired:${i}`, expiredAt);
    await collectDlmmShadowQuotes({ db });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_meteora_dlmm_shadow_quotes WHERE pool_id LIKE 'expired:%'").get()).toEqual({ n: 44 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_meteora_dlmm_shadow_quotes WHERE pool_id NOT LIKE 'expired:%'").get()).toEqual({ n: 3 });
  });

  it("does not interpret Meteora dynamic AMM state as DLMM or observed absence", async () => {
    const { db, sqlite } = seedRetainedPool();
    const pair = capturedDlmmAccounts(capture).get(capture.poolAddress)!;
    vi.mocked(fetchSolanaAccountBatch).mockResolvedValue({ slot: capture.slot, accounts: new Map([[capture.poolAddress, { ...pair, owner: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB" }]]) });
    expect(await collectDlmmShadowQuotes({ db })).toMatchObject({ attempted: 0, persisted: 0, failed: 0, skippedIneligible: { "not-dlmm-pool-owner": 1 } });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_meteora_dlmm_shadow_quotes").get()).toEqual({ n: 0 });
  });

  it("propagates outer cancellation rather than committing a healthy cursor", async () => {
    const { db } = seedRetainedPool();
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(collectDlmmShadowQuotes({ db, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fetchSolanaAccountBatch).not.toHaveBeenCalled();
  });

  it("recognizes direct DLMM as activation-pending but does not infer cg-amm or dynamic-AMM capabilities", () => {
    const input = { identity: { chainNorm: "solana", protocol: "meteora", poolType: "meteora-dlmm" } } as DexExecutionTargetFactoryInput;
    expect(buildMeteoraDlmmRegisteredExecutionTarget(input)).toEqual({ executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } });
    for (const poolType of ["cg-amm", "meteora-damm", "constant-product"]) {
      expect(buildMeteoraDlmmRegisteredExecutionTarget({ ...input, identity: { ...input.identity, poolType } })).toBeNull();
    }
    const registration = getDexExecutionCapabilityRegistration("meteora-dlmm-exact-v1")!;
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: registration.profileId, chain: "solana" }, registration)).toBe(false);
    expect(buildRegisteredDirectApiExecutionTarget({ pool: { source: "meteora", chain: "solana", poolAddress: capture.poolAddress,
      poolType: "meteora-dlmm", tokens: [{ address: capture.tokenMintIn, symbol: "JUPUSD", decimals: 6 }, { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 }],
      price: 1, tvlUsd: 100_000, volume24hUsd: 1000, feeRate: null, balances: null }, stablecoinId: "jupusd-jupiter",
      chainAddressToId: new Map(), symbolToChainScopedIds: new Map(), stablecoinPriceById: new Map(), validationReferences: { rates: {}, type: "none", updatedAt: null },
      executionTargetContext: { uniV3ExecutionCandidates: new Map(), uniswapV4ExecutionCandidates: new Map(), measuredTargetCapturedAt: 1, contractMetaByChainAddress: new Map() } }))
      .toEqual({ executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } });
  });
});
