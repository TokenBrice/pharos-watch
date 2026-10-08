import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type * as SolanaModule from "../../reserve-adapters/solana";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getDexExecutionCapabilityRegistration, isDexExecutionProfileAdmittedForScoring } from "@shared/lib/p4-exit-route-capability-policy";
import fixture from "./fixtures/whirlpool-slot-449058549.json";
import raydiumFixture from "./fixtures/raydium-slot-449058549.json";
import pinned from "./fixtures/solana-clmm-wave4-pinned.json";
import { collectWhirlpoolShadowQuotes, collectRaydiumShadowQuotes } from "../solana/whirlpool-shadow";
import { buildOrcaWhirlpoolRegisteredExecutionTarget } from "../execution-targets/orca-whirlpool";
import { buildRaydiumClmmRegisteredExecutionTarget } from "../execution-targets/raydium-clmm";
import type { DexExecutionTargetFactoryInput } from "../execution-target-registry";
import { fetchSolanaAccountBatch, type SolanaAccount } from "../../reserve-adapters/solana";
import { decodeWhirlpool } from "../solana/whirlpool-quote";
import * as WhirlpoolQuote from "../solana/whirlpool-quote";
import type { SolanaDexBankCapture } from "@shared/types/solana-dex-bank";

vi.mock("../orchestrator-phases/lookups", () => ({ loadTrackedStablecoinMaps: vi.fn(async () => ({ stablecoinPriceById: new Map([["usx-solstice", 1], ["jupusd-jupiter", 1], ["usdc-circle", 1]]) })) }));
vi.mock("../../reserve-adapters/solana", async (original) => ({ ...await original<typeof SolanaModule>(), fetchSolanaAccountBatch: vi.fn() }));
const fixtures = createLatestSchemaFixtureTracker();
const batch = vi.mocked(fetchSolanaAccountBatch);
const poolId = `solana:${fixture.poolAddress}`;
const mint = () => { const data = new Uint8Array(82); data[44] = 6; data[45] = 1; return { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data }; };
const accounts = new Map<string, SolanaAccount>(Object.entries(fixture.accounts).map(([key, account]) => [key, { owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) }]));
const fixturePool = decodeWhirlpool(accounts.get(fixture.poolAddress)!.data, fixture.slot);

beforeEach(() => { batch.mockReset(); });
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

function seed(sqlite: DatabaseSync) {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state, top_pools_json)
    VALUES (?, ?, ?, 'shadow-fixture', 'published', ?)`)
    .run("usx-solstice", "USX", now, JSON.stringify([{ poolId, project: "orca", chain: "Solana", tvlUsd: 16000000 }]));
  sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state)
    VALUES ('__global__', 'GLOBAL', ?, 'shadow-fixture', 'published')`).run(now);
  // A fresh discovery-only pool must not enter the public-retained collector.
  sqlite.prepare(`INSERT INTO dex_pool_registry (pool_id, stablecoin_id, source, chain, protocol, symbol, tvl_usd, discovered_at, refreshed_at)
    VALUES ('solana:22222222222222222222222222222222', 'usx-solstice', 'orca', 'solana', 'orca', 'USX-USDC', 99999999, ?, ?)`).run(now, now);
}

function serveAccounts(token2022 = false) {
  let active = 0;
  let peak = 0;
  batch.mockImplementation(async (addresses) => {
    active++; peak = Math.max(peak, active);
    await Promise.resolve();
    const result = new Map<string, SolanaAccount | null>();
    for (const address of addresses) {
      const account = accounts.get(address);
      if (account) result.set(address, account);
      else if (address === fixturePool.tokenMintA || address === fixturePool.tokenMintB) result.set(address, { ...mint(), ...(token2022 ? { owner: "Token2022" } : {}) });
      else result.set(address, null);
    }
    active--;
    return { slot: fixture.slot, accounts: result };
  });
  return () => peak;
}

describe("Orca native shadow producer", () => {
  it("bounds deduplicated retained intake and advances past ineligible candidates", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const pools = Array.from({ length: 70 }, (_, i) => ({
      poolId: `solana:${"A".repeat(30)}${alphabet[Math.floor(i / alphabet.length)]}${alphabet[i % alphabet.length]}`,
      project: "orca", chain: "Solana", tvlUsd: 1000 - i,
    }));
    sqlite.prepare("UPDATE dex_liquidity SET top_pools_json = ? WHERE stablecoin_id = 'usx-solstice'")
      .run(JSON.stringify([...pools, ...pools]));
    batch.mockImplementation(async (addresses) => ({ slot: fixture.slot, accounts: new Map(addresses.map((address) => [address, null])) }));
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({
      retainedCandidateCount: 70, retainedCandidatesRead: 64, sourceGenerationId: "shadow-fixture", attempted: 0,
    });
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({ retainedCandidateCount: 70, retainedCandidatesRead: 6, attempted: 0 });
    expect(batch).toHaveBeenCalledTimes(70);
  });

  it("persists the captured native quote in shadow only with sequential RPC and replay-safe identity", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    const peak = serveAccounts();
    const result = await collectWhirlpoolShadowQuotes({ db });
    expect(result).toMatchObject({ attempted: 1, persisted: 1, failed: 0, scoreEligible: false });
    expect(peak()).toBe(1);
    expect(batch.mock.calls.map(([addresses]) => addresses.length)).toEqual([1, 2, 8]);
    expect(sqlite.prepare("SELECT pool_id, slot, notional_usd, amount_in, amount_out, model_version, capability_id, score_eligible FROM dex_native_shadow_quotes_v2 WHERE notional_usd = 1000").all()).toEqual([{
      pool_id: poolId, slot: fixture.slot, notional_usd: 1000, amount_in: fixture.amountIn, amount_out: fixture.amountOut,
      model_version: "orca-whirlpool-native-v1", capability_id: "measured-adapter-shadow", score_eligible: 0,
    }]);
    await collectWhirlpoolShadowQuotes({ db });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2 WHERE notional_usd = 1000").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_measured_execution_quotes").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_measured_execution_targets").get()).toEqual({ n: 0 });
    expect(() => sqlite.prepare("UPDATE dex_native_shadow_quotes_v2 SET score_eligible = 1").run()).toThrow();
  });

  it("captures final-bank bytes without claiming executable proof", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite); serveAccounts();
    const captures: SolanaDexBankCapture[] = [];
    const result = await collectWhirlpoolShadowQuotes({ db, onBankCapture: (capture) => { captures.push(capture); } });
    expect(result.persisted).toBe(1);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ slot: fixture.slot, scoreEligible: false, programClosureComplete: false, independentExecution: false });
    for (const address of [fixturePool.tokenMintA, fixturePool.tokenMintB]) {
      expect(captures[0].accounts.find((entry) => entry.address === address)?.account?.dataBase64).toBe(Buffer.from(mint().data).toString("base64"));
    }
  });

  it("rejects a mint that becomes unsupported in the final bank", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite); serveAccounts();
    const serve = batch.getMockImplementation()!;
    batch.mockImplementation(async (...args) => {
      const result = await serve(...args);
      if (args[0].length > 2) result.accounts.set(fixturePool.tokenMintA, { ...mint(), owner: "Token2022" });
      return result;
    });
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({ attempted: 1, persisted: 0, failed: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2").get()).toEqual({ n: 0 });
  });

  it("skips a missing retained input mint if the validated snapshot contract regresses", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite); serveAccounts();
    const fetchSnapshot = WhirlpoolQuote.fetchWhirlpoolSnapshot;
    vi.spyOn(WhirlpoolQuote, "fetchWhirlpoolSnapshot").mockImplementationOnce(async (...args) => {
      const snapshot = await fetchSnapshot(...args);
      // The real snapshot validates both mints; deliberately break its return
      // contract to exercise the collector's defensive typed skip.
      return { ...snapshot, mints: [] };
    });
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({
      attempted: 1, persisted: 0, failed: 0, quotePointsPersisted: 0, quotePointsRejected: 0,
      skippedIneligible: { "invalid-retained-mint": 1 }, failures: [],
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2").get()).toEqual({ n: 0 });
  });

  it("retries the retained-pool read through transient D1 overload", async () => {
    const opened = fixtures.open(); seed(opened.sqlite);
    let overloaded = false;
    const db = {
      ...opened.db,
      prepare(sql: string) {
        if (!overloaded && sql.includes("json_extract(pool.value, '$.poolId')")) {
          overloaded = true;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        }
        return opened.db.prepare(sql);
      },
    } as typeof opened.db;
    serveAccounts();

    const result = await collectWhirlpoolShadowQuotes({ db });

    expect(result).toMatchObject({ attempted: 1, persisted: 1, failed: 0, scoreEligible: false });
    expect(overloaded).toBe(true);
    expect(opened.sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2 WHERE notional_usd = 1000").get()).toEqual({ n: 1 });
  });

  it("rejects transfer-fee capable mint ownership before snapshot/quote", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite); serveAccounts(true);
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({ attempted: 0, persisted: 0, failed: 0, skippedIneligible: { "unsupported-token-mint": 1 } });
    expect(batch).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2").get()).toEqual({ n: 0 });
  });

  it("stops before RPC when its wall-clock budget has elapsed", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 45_001);
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({ attempted: 0, persisted: 0, budgetExhausted: true });
    expect(batch).not.toHaveBeenCalled();
  });

  it("skips five adaptive pools and an unpriced asset before spending a quote rotation slot", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    const rejected = Array.from({ length: 5 }, (_, i) => ({ poolId: `solana:${String(i + 2).repeat(32)}`, project: "orca", chain: "Solana", tvlUsd: 99000000 - i }));
    sqlite.prepare("UPDATE dex_liquidity SET top_pools_json = ? WHERE stablecoin_id = 'usx-solstice'")
      .run(JSON.stringify([...rejected, { poolId, project: "orca", chain: "Solana", tvlUsd: 16000000 }]));
    sqlite.prepare(`INSERT INTO dex_liquidity (stablecoin_id, symbol, updated_at, publication_generation_id, publication_state, top_pools_json)
      VALUES ('usdt-tether', 'USDT', ?, 'shadow-fixture', 'published', ?)`)
      .run(Math.floor(Date.now() / 1000), JSON.stringify([{ poolId: `solana:${"7".repeat(32)}`, project: "orca", chain: "Solana", tvlUsd: 100000000 }]));
    serveAccounts();
    const serve = batch.getMockImplementation()!;
    batch.mockImplementation(async (...args) => {
      const address = args[0][0];
      if (args[0].length === 1 && rejected.some((pool) => pool.poolId === `solana:${address}`)) {
        const account = accounts.get(fixture.poolAddress)!;
        const data = account.data.slice(); data[43] = 2;
        return { slot: fixture.slot, accounts: new Map([[address, { ...account, data }]]) };
      }
      return serve(...args);
    });
    expect(await collectWhirlpoolShadowQuotes({ db })).toMatchObject({
      attempted: 1, persisted: 1, failed: 0,
      skippedIneligible: { "adaptive-fee-whirlpool": 5, "trusted-input-price-unavailable": 1 },
    });
    expect(batch.mock.calls.some(([addresses]) => addresses.includes("7".repeat(32)))).toBe(false);
    expect(sqlite.prepare("SELECT amount_out FROM dex_native_shadow_quotes_v2").get()).toEqual({ amount_out: fixture.amountOut });
  });

  it("persists Raydium reference output only in the family-generic shadow store", async () => {
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    sqlite.prepare("UPDATE dex_liquidity SET stablecoin_id = 'jupusd-jupiter', top_pools_json = ? WHERE stablecoin_id = 'usx-solstice'")
      .run(JSON.stringify([{ poolId: `solana:${raydiumFixture.poolAddress}`, project: "raydium", poolType: "raydium-clmm", chain: "Solana", tvlUsd: 16000000 }]));
    const rayAccounts = new Map(Object.entries(raydiumFixture.accounts).map(([address, account]) => [address, { owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) }]));
    batch.mockImplementation(async (addresses) => ({ slot: raydiumFixture.slot, accounts: new Map(addresses.map((address) => [address, rayAccounts.get(address) ?? null])) }));
    const captures: SolanaDexBankCapture[] = [];
    const result = await collectRaydiumShadowQuotes({ db, onBankCapture: (capture) => { captures.push(capture); } });
    expect(result).toMatchObject({ attempted: 1, persisted: 1, failed: 0, scoreEligible: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ profileId: "raydium-clmm-exact-v1", slot: raydiumFixture.slot, independentExecution: false, programClosureComplete: false });
    expect(captures[0].accounts.every((entry) => entry.account != null)).toBe(true);
    expect(sqlite.prepare("SELECT amount_out, profile_id, score_eligible FROM dex_native_shadow_quotes_v2 WHERE notional_usd = 1000").all()).toEqual([
      { amount_out: raydiumFixture.amountOut, profile_id: "raydium-clmm-exact-v1", score_eligible: 0 },
    ]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_measured_execution_quotes").get()).toEqual({ n: 0 });
    await collectRaydiumShadowQuotes({ db });
    expect(sqlite.prepare("SELECT count(*) AS n FROM dex_native_shadow_quotes_v2 WHERE notional_usd = 1000").get()).toEqual({ n: 1 });
  });

  it("accrues same-bank policy ladder history and leaves a failed large probe unknown", async () => {
    const capture = pinned.snapshots.find((snapshot) => snapshot.symbol === "USX / USDC")!;
    const { db, sqlite } = fixtures.open(); seed(sqlite);
    sqlite.prepare("UPDATE dex_liquidity SET stablecoin_id = 'usdc-circle' WHERE stablecoin_id = 'usx-solstice'").run();
    const raw = z.record(z.string(), z.object({ owner: z.string(), data: z.array(z.string()) })).parse(capture.accounts);
    batch.mockImplementation(async (addresses) => ({
      slot: capture.slot,
      accounts: new Map(addresses.map((address) => {
        const account = raw[address];
        return [address, account
          ? { owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], "base64")) }
          : address === fixturePool.tokenMintA || address === fixturePool.tokenMintB ? mint() : null];
      })),
    }));
    const result = await collectWhirlpoolShadowQuotes({ db });
    expect(result).toMatchObject({ attempted: 1, persisted: 1, failed: 0, quotePointsPersisted: 4, quotePointsRejected: 1, scoreEligible: false });
    expect(result.failures).toEqual([expect.stringContaining("@25000000:")]);
    expect(sqlite.prepare("SELECT slot, notional_usd, amount_out, score_eligible FROM dex_native_shadow_quotes_v2 ORDER BY notional_usd").all()).toEqual([
      { slot: capture.slot, notional_usd: 1000, amount_out: "1000297197", score_eligible: 0 },
      { slot: capture.slot, notional_usd: 100000, amount_out: "100028505368", score_eligible: 0 },
      { slot: capture.slot, notional_usd: 1000000, amount_out: "1000178870068", score_eligible: 0 },
      { slot: capture.slot, notional_usd: 10000000, amount_out: "9997232980115", score_eligible: 0 },
    ]);
    await collectWhirlpoolShadowQuotes({ db });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_native_shadow_quotes_v2").get()).toEqual({ n: 4 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM dex_measured_execution_quotes").get()).toEqual({ n: 0 });
  });

  it("marks Orca activation pending and never admits its registered capability for scoring", () => {
    const input = { identity: { chainNorm: "solana", protocol: "orca" } } as DexExecutionTargetFactoryInput;
    expect(buildOrcaWhirlpoolRegisteredExecutionTarget(input)).toEqual({ executionCapabilityGate: { family: "measured-execution", reason: "activation-pending" } });
    const registration = getDexExecutionCapabilityRegistration("orca-whirlpool-exact-v1")!;
    expect(registration.capabilityId).toBe("measured-adapter-shadow");
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: registration.profileId, chain: "solana" }, registration)).toBe(false);
  });

  it("registers only Solana Raydium CLMM as activation-pending, never standard AMM", () => {
    const input = { identity: { chainNorm: "solana", protocol: "raydium", poolType: "raydium-clmm" } } as DexExecutionTargetFactoryInput;
    expect(buildRaydiumClmmRegisteredExecutionTarget(input)?.executionCapabilityGate?.reason).toBe("activation-pending");
    input.identity.poolType = "raydium-amm";
    expect(buildRaydiumClmmRegisteredExecutionTarget(input)).toBeNull();
    const registration = getDexExecutionCapabilityRegistration("raydium-clmm-exact-v1")!;
    expect(isDexExecutionProfileAdmittedForScoring({ adapterProfileId: registration.profileId, chain: "solana" }, registration)).toBe(false);
  });
});
