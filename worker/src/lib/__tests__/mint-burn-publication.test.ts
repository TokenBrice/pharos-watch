import { afterEach, describe, expect, it, vi } from "vitest";
import * as hashing from "@shared/lib/sha256";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { getMintBurnConfigsForStablecoin, MINT_BURN_CONFIGS } from "../mint-burn-contracts";
import { ACTIVE_MINT_BURN_CONFIGS } from "../../api/mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../../api/mint-burn-flows";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import { MINT_BURN_LEGACY_CUTOVER, mintBurnScanFingerprint } from "../mint-burn-pipeline/scan-coverage";
import { readMintBurnWindowContext, resolveMintBurnWatermark, finalizeMintBurnFlowResponse } from "../mint-burn-flows-service";
import { compactMintBurnPublication, isGrandfatheredMintBurnConfig, mintBurnDisabledReason, syncMintBurnPublicationPolicy } from "../mint-burn-publication";
import { aggregateFlowCacheKey } from "../mint-burn-flow-cache-keys";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });
const end = Date.parse("2027-02-01T12:00:00Z") / 1000;
const day = 86400;
const config = makeMintBurnConfig();
async function proof(db: D1Database, days: number, to = end, fromBlock = 1, toBlock = 100) {
  await upsertMintBurnSyncState(db, mintBurnConfigKey(config), toBlock, "monotonic-max", {
    configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
    fromBlock, toBlock, fromTimestamp: to - days * day, toTimestamp: to, finalizedBlock: toBlock, acceptedAt: end + day,
  });
}

describe("mint/burn durable publication admission", () => {
  it("explicitly grandfathers every pre-gate key without fabricating scan coverage", async () => {
    const { db } = fixtures.open();
    const legacy = MINT_BURN_CONFIGS.filter(isGrandfatheredMintBurnConfig);
    expect(legacy).toHaveLength(136);
    // A checked-in `enabled: false` leg (bUSD0) stays grandfathered but is disabled, not admitted.
    const enabledLegacy = legacy.filter((config) => config.enabled !== false);
    expect(enabledLegacy).toHaveLength(135);
    const scope = await readMintBurnWindowContext(db, end, MINT_BURN_CONFIGS);
    expect(scope.configs).toEqual(enabledLegacy);
    expect(scope.publication.legs.filter((leg) => leg.status === "admitted")
      .every((leg) => leg.reason === "legacy-grandfathered")).toBe(true);
    expect(scope.watermark).toEqual(resolveMintBurnWatermark(end, enabledLegacy, new Map()));
  });

  it("requires 90 days of current-fingerprint proof, persists admission, and retains a stalled admitted leg", async () => {
    const { db, sqlite } = fixtures.open();
    await proof(db, 31);
    let scope = await readMintBurnWindowContext(db, end + 60, [config]);
    expect(scope.configs).toEqual([]);
    expect(scope.publication.legs[0]).toMatchObject({ status: "pending-admission", reason: "baseline-incomplete", coveredSeconds: 31 * day });
    await proof(db, 90);
    scope = await readMintBurnWindowContext(db, end + 60, [config]);
    expect(scope.configs).toEqual([config]);
    expect(sqlite.prepare("SELECT baseline_to - baseline_from AS seconds FROM mint_burn_admission").get()).toEqual({ seconds: 90 * day });
    scope = await readMintBurnWindowContext(db, end + 10 * day, [config]);
    expect(scope.configs).toEqual([config]);
    expect(scope.watermark.unavailableReason).toBe("scan-watermark-stale");
    const revised = { ...config, decimals: config.decimals + 1 };
    expect((await readMintBurnWindowContext(db, end + 60, [revised])).configs).toEqual([revised]);
  });

  it("compacts publication diagnostics while retaining exact admitted pairs and non-admitted reasons", async () => {
    const { db } = fixtures.open();
    const { publication } = await readMintBurnWindowContext(db, end, MINT_BURN_CONFIGS);
    const compact = compactMintBurnPublication(publication);
    expect(compact).toMatchObject({ legsScope: "non-admitted", legCount: MINT_BURN_CONFIGS.length,
      admittedCount: 135, pendingAdmissionCount: 2, disabledCount: 1 });
    expect(compact.legs).toEqual(publication.legs.filter((leg) => leg.status !== "admitted"));
    expect(new Set(compact.admittedPairs!.map((pair) => JSON.stringify(pair)))).toEqual(new Set(publication.legs
      .filter((leg) => leg.status === "admitted").map((leg) => JSON.stringify([leg.stablecoinId, leg.chainId]))));
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(publication).length / 4);
    expect(publication.legs).toHaveLength(MINT_BURN_CONFIGS.length);
  });

  it.each(["gap", "dirty", "stale"])("rejects %s proof without latching admission", async (defect) => {
    const { db, sqlite } = fixtures.open();
    if (defect === "gap") {
      await proof(db, 45, end - 45 * day, 1, 50);
      await proof(db, 45, end, 52, 100);
    } else {
      await proof(db, 90, defect === "stale" ? end - day : end);
      if (defect === "dirty") sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, ?, ?)")
        .run(config.stablecoinId, config.chain.chainId, end - 3600);
    }
    expect((await readMintBurnWindowContext(db, end + 60, [config])).configs).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_admission").get()).toEqual({ n: 0 });
  });

  it("honors ID, config-key, symbol and enabled switches through one ingestion authority", () => {
    expect(mintBurnDisabledReason(config, new Set([config.stablecoinId]), new Set())).toBe("id-disabled");
    expect(mintBurnDisabledReason(config, new Set([mintBurnConfigKey(config).toLowerCase()]), new Set())).toBe("id-disabled");
    expect(mintBurnDisabledReason(config, new Set(), new Set([config.symbol.toUpperCase()]))).toBe("symbol-disabled");
    expect(mintBurnDisabledReason({ ...config, enabled: false }, new Set(), new Set())).toBe("config-disabled");
  });

  it("purges disabled publications, fences old writers, and restores the durable admission on re-enable", async () => {
    const { db, sqlite } = fixtures.open();
    await proof(db, 90);
    await readMintBurnWindowContext(db, end, [config]);
    const key = aggregateFlowCacheKey(24);
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(key, "{}", end);
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(config)], end + 1);
    const disabled = await readMintBurnWindowContext(db, end + 2, [config]);
    expect(disabled.configs).toEqual([]);
    expect(disabled.publication.legs[0].reason).toBe("operator-disabled");
    const superseded = await finalizeMintBurnFlowResponse(db, key, end + 3, {}, { status: "ok", timestamp: end }, "[]");
    expect(superseded.status).toBe(503);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(key)).toBeUndefined();
    await syncMintBurnPublicationPolicy(db, [], end + 4);
    const stale = await readMintBurnWindowContext(db, end + day, [config]);
    expect(stale.configs).toEqual([]);
    expect(stale.publication.legs[0].reason).toBe("reactivation-pending");
    await proof(db, 1, end + day, 100, 101);
    expect((await readMintBurnWindowContext(db, end + day + 60, [config])).configs).toEqual([config]);
    expect((await readMintBurnWindowContext(db, end + 2 * day, [config])).configs).toEqual([config]);
  });

  it("preserves edited grandfathered keys and both edited BUIDL siblings in scope", async () => {
    const { db } = fixtures.open();
    const existing = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether")!;
    const revised = { ...existing, decimals: existing.decimals + 1, startBlock: existing.startBlock + 1 };
    expect(isGrandfatheredMintBurnConfig(revised)).toBe(true);
    expect((await readMintBurnWindowContext(db, end, [revised])).configs).toEqual([revised]);
    const siblings = MINT_BURN_CONFIGS.filter((entry) => entry.stablecoinId === "buidl-blackrock" && entry.chain.chainId === "ethereum");
    const edited = siblings.map((entry, i) => i ? entry : { ...entry, decimals: entry.decimals + 1 });
    const scope = await readMintBurnWindowContext(db, end, edited);
    expect(scope.configs).toEqual(edited);
    expect(scope.publication.legs.every((leg) => leg.status === "admitted")).toBe(true);
  });

  it("keeps a re-activated key pending without repeating its 90-day admission", async () => {
    const { db } = fixtures.open();
    await proof(db, 90);
    await readMintBurnWindowContext(db, end, [config]);
    await syncMintBurnPublicationPolicy(db, [], end + 1, []);
    await syncMintBurnPublicationPolicy(db, [], end + day, [mintBurnConfigKey(config)]);
    expect((await readMintBurnWindowContext(db, end + day, [config])).publication.legs[0].reason).toBe("reactivation-pending");
    await proof(db, 1, end + day, 101, 102);
    expect((await readMintBurnWindowContext(db, end + day + 60, [config])).configs).toEqual([config]);
  });

  it("holds a shared BUIDL bucket together during stale re-enable", async () => {
    const { db } = fixtures.open();
    const siblings = MINT_BURN_CONFIGS.filter((entry) => entry.stablecoinId === "buidl-blackrock" && entry.chain.chainId === "ethereum");
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(siblings[0])], end);
    await syncMintBurnPublicationPolicy(db, [], end + day);
    const scope = await readMintBurnWindowContext(db, end + day, siblings);
    expect(scope.configs).toEqual([]);
    expect(scope.publication.legs.map((leg) => leg.reason)).toEqual(["reactivation-pending", "reactivation-pending"]);
  });

  it("memoizes identical fingerprints but invalidates an edited source on the same object", () => {
    const hash = vi.spyOn(hashing, "sha256Hex");
    const edited = { ...makeMintBurnConfig(), decimals: 17 };
    const first = mintBurnScanFingerprint(edited);
    expect(mintBurnScanFingerprint(edited)).toBe(first);
    expect(hash).toHaveBeenCalledTimes(1);
    edited.decimals = 16;
    expect(mintBurnScanFingerprint(edited)).not.toBe(first);
    expect(hash).toHaveBeenCalledTimes(2);
  });

  it("retries a guarded cache write on D1 overload without bypassing the policy fence", async () => {
    const { db, sqlite } = fixtures.open();
    const prepare = db.prepare.bind(db);
    let attempts = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("INSERT INTO cache")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = bind(...values);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          if (++attempts === 1) throw new Error("D1 DB is overloaded");
          return run();
        };
        return bound;
      };
      return statement;
    });
    const key = aggregateFlowCacheKey(24);
    const response = await finalizeMintBurnFlowResponse(db, key, end, {}, { status: "ok", timestamp: end }, "[]");
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(key)).toEqual({ key });
  });

  it("keeps new sibling contracts pending and disables an indivisible legacy shared bucket", async () => {
    const { db } = fixtures.open();
    const legacy = MINT_BURN_CONFIGS.filter((entry) => entry.stablecoinId === "buidl-blackrock" && entry.chain.chainId === "ethereum");
    expect(legacy).toHaveLength(2);
    const sibling = { ...legacy[0], contractAddress: `0x${"a".repeat(40)}` };
    const scope = await readMintBurnWindowContext(db, end, [...legacy, sibling]);
    expect(scope.configs).toEqual(legacy);
    expect(scope.publication.legs[2].reason).toBe("unsupported-shared-bucket");
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(legacy[0])], end);
    const disabled = await readMintBurnWindowContext(db, end, legacy);
    expect(disabled.configs).toEqual([]);
    expect(disabled.publication.legs[1].reason).toBe("shared-bucket-disabled");
  });

  it("does not let a pending sibling change an incumbent's legacy coverage", async () => {
    const { db, sqlite } = fixtures.open();
    const legacy = MINT_BURN_CONFIGS.find((entry) => entry.stablecoinId === "usdt-tether" && entry.chain.chainId === "ethereum")!;
    const key = mintBurnConfigKey(legacy);
    const now = MINT_BURN_LEGACY_CUTOVER + 3600;
    await upsertMintBurnSyncState(db, key, legacy.startBlock + 100, "monotonic-max", {
      configKey: key, configFingerprint: mintBurnScanFingerprint(legacy), chainId: legacy.chain.chainId,
      fromBlock: legacy.startBlock + 1, toBlock: legacy.startBlock + 100,
      fromTimestamp: MINT_BURN_LEGACY_CUTOVER - 3600, toTimestamp: now,
      finalizedBlock: legacy.startBlock + 100, acceptedAt: now,
    });
    sqlite.prepare(`INSERT INTO mint_burn_hourly
      (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
      VALUES (?, ?, ?, 1, 0, 1, 0, 1)`).run(legacy.stablecoinId, legacy.chain.chainId, MINT_BURN_LEGACY_CUTOVER - 30 * day);
    const before = await readMintBurnWindowContext(db, now, [legacy]);
    const sibling = { ...legacy, contractAddress: `0x${"a".repeat(40)}` };
    const after = await readMintBurnWindowContext(db, now, [legacy, sibling]);
    expect(before.legacy.get(key)?.start).toBe(MINT_BURN_LEGACY_CUTOVER - 30 * day);
    expect(after.legacy).toEqual(before.legacy);
    expect(after.watermark).toEqual(before.watermark);
  });

  it("keeps a quarantined grandfathered key readable after its operator switch is removed", async () => {
    const { db, sqlite } = fixtures.open();
    // tbill-openeden is quarantined: it is absent from ACTIVE_MINT_BURN_CONFIGS, so the
    // per-coin endpoint reads it through its full configured roster.
    const quarantined = getMintBurnConfigsForStablecoin("tbill-openeden")[0]!;
    const key = mintBurnConfigKey(quarantined);
    expect(isGrandfatheredMintBurnConfig(quarantined)).toBe(true);
    expect(ACTIVE_MINT_BURN_CONFIGS.some((entry) => entry.stablecoinId === "tbill-openeden")).toBe(false);

    const nowSec = Math.floor(Date.now() / 1000);
    const hourTs = Math.floor(nowSec / 3600) * 3600 - 3600;
    sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
      mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
      VALUES (?, ?, ?, 1, 0, 0, 0, 1000000, 0, 1000000)`).run(quarantined.stablecoinId, quarantined.chain.chainId, hourTs);
    sqlite.prepare(`INSERT INTO mint_burn_events
      (id, stablecoin_id, symbol, chain_id, direction, amount, amount_usd, timestamp,
       flow_type, tx_hash, block_number, explorer_tx_url)
      VALUES ('retained', ?, ?, ?, 'mint', 1000000, 1000000, ?,
        'standard', '0xfeed', 1, 'https://example.com')`).run(quarantined.stablecoinId, quarantined.symbol, quarantined.chain.chainId, hourTs);

    const activeKeys = ACTIVE_MINT_BURN_CONFIGS.map(mintBurnConfigKey);
    // Scheduled run 1: the operator disabled this key while the coin was still active.
    await syncMintBurnPublicationPolicy(db, [key], hourTs, activeKeys);
    // Scheduled run 2: the coin has left the active roster and the switch is gone.
    await syncMintBurnPublicationPolicy(db, [], hourTs + 60, activeKeys);
    expect(sqlite.prepare("SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1").get())
      .toEqual({ disabled_keys: "[]" });
    expect(sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy WHERE id = 1").get())
      .toEqual({ paused_keys: "[]" });

    const response = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?stablecoin=${quarantined.stablecoinId}`));
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.chains.map((chain) => chain.chainId)).toEqual([quarantined.chain.chainId]);
    expect(body.mintCount).toBe(1);
    expect(body.mintVolumeUsd).toBe(1_000_000);
    expect(body.publication).toMatchObject({ admittedCount: 1, legs: [] });
  });
});
