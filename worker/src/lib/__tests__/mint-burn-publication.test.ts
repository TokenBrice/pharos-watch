import { afterEach, describe, expect, it, vi } from "vitest";
import * as hashing from "@shared/lib/sha256";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";
import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { getMintBurnConfigsForStablecoin, MINT_BURN_CONFIGS, type MintBurnContractConfig } from "../mint-burn-contracts";
import { ACTIVE_MINT_BURN_CONFIGS } from "../../api/mint-burn-flows/aggregate";
import { handleMintBurnFlows } from "../../api/mint-burn-flows";
import { makeMintBurnConfig } from "../../test-helpers/__shared/mint-burn-config";
import { mintBurnConfigKey, upsertMintBurnSyncState } from "../mint-burn-pipeline/sync-state";
import { MINT_BURN_LEGACY_CUTOVER, mintBurnScanFingerprint } from "../mint-burn-pipeline/scan-coverage";
import { MINT_BURN_WATERMARK_MAX_AGE_SEC, readMintBurnWindowContext as readContext, resolveMintBurnWatermark, finalizeMintBurnFlowResponse } from "../mint-burn-flows-service";
import {
  compactMintBurnPublication,
  isGrandfatheredMintBurnConfig,
  mintBurnDisabledReason,
  resolveMintBurnDisabledSymbolPolicy,
  resolveMintBurnDisabledSymbols,
  syncMintBurnPublicationPolicy,
} from "../mint-burn-publication";
import { aggregateFlowCacheKey } from "../mint-burn-flow-cache-keys";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });
const end = Date.parse("2027-02-01T12:00:00Z") / 1000;
const day = 86400;
const config = makeMintBurnConfig({ chain: MINT_BURN_CONFIGS.find((entry) => entry.chain.chainId === "base")!.chain });
const byId = (id: string) => getMintBurnConfigsForStablecoin(id).filter((entry) => entry.chain.chainId === "ethereum");
const usdc = byId("usdc-circle")[0];
const pausedKeys = (sqlite: ReturnType<typeof fixtures.open>["sqlite"]) => JSON.parse(String(
  (sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy WHERE id = 1").get() as { paused_keys: string }).paused_keys));
const readScope = (db: D1Database, now: number, configs: readonly MintBurnContractConfig[]) => readContext(db, now,
  [...configs, ...ACTIVE_MINT_BURN_CONFIGS.filter((entry) => !configs.some((config) => mintBurnConfigKey(config) === mintBurnConfigKey(entry)))
    .map((entry) => ({ ...entry, enabled: false }))]);
async function proofFor(db: D1Database, entry: MintBurnContractConfig, days: number, to = end, fromBlock = 1, toBlock = 100) {
  await upsertMintBurnSyncState(db, mintBurnConfigKey(entry), toBlock, "monotonic-max", {
    configKey: mintBurnConfigKey(entry), configFingerprint: mintBurnScanFingerprint(entry), chainId: entry.chain.chainId,
    fromBlock, toBlock, fromTimestamp: to - days * day, toTimestamp: to, finalizedBlock: toBlock, acceptedAt: to + day,
  });
}
async function proof(db: D1Database, days: number, to = end, fromBlock = 1, toBlock = 100) {
  await proofFor(db, config, days, to, fromBlock, toBlock);
}

describe("mint/burn durable publication admission", () => {
  it("explicitly grandfathers every pre-gate key without fabricating scan coverage", async () => {
    const { db } = fixtures.open();
    const legacy = MINT_BURN_CONFIGS.filter(isGrandfatheredMintBurnConfig);
    expect(legacy).toHaveLength(134);
    const scope = await readContext(db, end, MINT_BURN_CONFIGS);
    expect(scope.configs).toEqual(legacy);
    expect(scope.publication.legs.filter((leg) => leg.status === "admitted")
      .every((leg) => leg.reason === "legacy-grandfathered")).toBe(true);
    expect(scope.watermark).toEqual(resolveMintBurnWatermark(end, legacy, new Map()));
  });

  it("requires 90 days of current-fingerprint proof, persists admission, and retains a stalled admitted leg", async () => {
    const { db, sqlite } = fixtures.open();
    await proof(db, 31);
    let scope = await readScope(db, end + 60, [config]);
    expect(scope.configs).toEqual([]);
    expect(scope.diagnosticConfigs).toEqual([]);
    expect(scope.publication.legs[0]).toMatchObject({ status: "pending-admission", reason: "baseline-incomplete", coveredSeconds: 31 * day });
    await proof(db, 90);
    scope = await readScope(db, end + 60, [config]);
    expect(scope.configs).toEqual([config]);
    expect(sqlite.prepare("SELECT baseline_to - baseline_from AS seconds FROM mint_burn_admission").get()).toEqual({ seconds: 90 * day });
    await syncMintBurnPublicationPolicy(db, [], end);
    scope = await readScope(db, end + 10 * day, [config]);
    expect(scope.configs).toEqual([config]);
    expect(scope.watermark.unavailableReason).toBe("scan-watermark-stale");
    expect(pausedKeys(sqlite)).toEqual([]);
    sqlite.prepare("DELETE FROM mint_burn_scan_coverage").run();
    scope = await readScope(db, end, [config]);
    expect(scope.watermark.unavailableReason).toBe("scan-watermark-unavailable");
    expect(scope.configs).toEqual([config]);
    expect(pausedKeys(sqlite)).toEqual([]);
    const revised = { ...config, decimals: config.decimals + 1 };
    expect((await readScope(db, end + 60, [revised])).configs).toEqual([revised]);
  });

  it.each(["stale", "missing", "edited", "grandfathered"])("quarantines %s proof only through reactivation catch-up", async (defect) => {
    const { db, sqlite } = fixtures.open();
    let stalled = defect === "grandfathered" ? usdc : { ...usdc, chain: config.chain, contractAddress: "0x0000000000000000000000000000000000000002" };
    const freshKey = mintBurnConfigKey(config);
    const stalledKey = mintBurnConfigKey(stalled);
    await proof(db, 90);
    await proofFor(db, stalled, 90);
    expect((await readScope(db, end + 60, [config, stalled])).configs).toEqual([config, stalled]);
    await syncMintBurnPublicationPolicy(db, [], end + 60, [freshKey, stalledKey]);
    const now = end + MINT_BURN_WATERMARK_MAX_AGE_SEC + 3600;
    await proofFor(db, config, 1, now, 101, 200);
    if (defect === "missing") sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key = ?").run(stalledKey);
    if (defect === "edited") stalled = { ...stalled, decimals: stalled.decimals + 1 };
    const gated = await readScope(db, now, [config, stalled]);
    expect(gated.diagnosticConfigs).toEqual([config, stalled]);
    expect(gated.configs).toEqual([config]);
    expect(gated.watermark).toMatchObject({ timestamp: now, unavailableReason: null });
    expect(gated.publication.legs.find((leg) => leg.configKey === stalledKey))
      .toMatchObject({ status: "pending-admission", reason: "reactivation-pending" });
    // The quarantine is durable, so a fresher frontier alone cannot re-admit it.
    expect(pausedKeys(sqlite)).toContain(stalledKey);
    await proofFor(db, stalled, 1, now - 3600, 101, 200);
    expect((await readScope(db, now + 60, [config, stalled])).configs).toEqual([config]);
    await proofFor(db, stalled, 1, now, 201, 300);
    expect((await readScope(db, now + 120, [config, stalled])).configs).toEqual([config, stalled]);
    expect(pausedKeys(sqlite)).not.toContain(stalledKey);
  });

  it.each(["shared-only", "independent", "stale-sibling", "stale", "dirty", "gapped", "non-overlapping", "partial"])(
    "proves survivors after bucket closure: %s", async (defect) => {
      const { db, sqlite } = fixtures.open();
      const siblings = byId("buidl-blackrock");
      const roster = defect === "shared-only" ? siblings : [...siblings, config];
      if (defect === "non-overlapping" || defect === "partial") roster.push(usdc);
      for (const entry of roster) await proofFor(db, entry, 90);
      await readScope(db, end, roster);
      await syncMintBurnPublicationPolicy(db, [], end, roster.map(mintBurnConfigKey));
      const paused = pausedKeys(sqlite);
      sqlite.prepare("DELETE FROM mint_burn_scan_coverage WHERE config_key != ?").run(mintBurnConfigKey(siblings[1]));
      if (defect === "stale-sibling") sqlite.prepare("DELETE FROM mint_burn_scan_coverage").run();
      else roster[1] = siblings[1] = { ...siblings[1], decimals: siblings[1].decimals + 1 };
      await proofFor(db, siblings[0], 1);
      if (defect === "stale") await proof(db, 1, end - day);
      else if (defect === "dirty") {
        await proof(db, 1);
        for (let hour = end - 9 * 3600; hour < end; hour += 3600) sqlite.prepare(
          "INSERT INTO mint_burn_dirty_hours VALUES (?, ?, ?)").run(config.stablecoinId, config.chain.chainId, hour);
      } else if (defect === "gapped" || defect === "partial") {
        await proof(db, 0.5 / 24, end - 1800, 1, 10);
        await proof(db, 0.5 / 24, end, 12, 20);
        if (defect === "partial") await proofFor(db, usdc, 1);
      } else if (defect === "non-overlapping") {
        await proofFor(db, usdc, 1 / 24, end - 3600);
        await proof(db, 1 / 24);
      } else if (defect === "independent" || defect === "stale-sibling") {
        await proof(db, 1);
        if (defect === "stale-sibling") await proofFor(db, siblings[1], 1, end - day);
      }
      const scope = await readScope(db, end, roster);
      const isolated = defect === "independent" || defect === "stale-sibling";
      expect(scope.configs).toEqual(isolated ? [config] : roster);
      expect(scope.watermark.unavailableReason).toBe(isolated ? null : "scan-watermark-unavailable");
      if (defect === "partial") {
        await readContext(db, end, [...siblings, usdc]);
        expect((await readScope(db, end, roster)).watermark.unavailableReason).toBe("scan-watermark-unavailable");
      }
      expect(pausedKeys(sqlite).sort()).toEqual([...paused, ...(isolated ? siblings.map(mintBurnConfigKey) : [])].sort());
      if (defect === "independent") {
        const later = end + 3600;
        await proof(db, 1, later, 101, 200);
        await proofFor(db, siblings[1], 1, later, 101, 200);
        const held = await readScope(db, later, roster);
        expect(held.configs).toEqual([config]);
        expect(held.publication.legs.slice(0, 2).map((leg) => leg.reason)).toEqual(["reactivation-pending", "reactivation-pending"]);
        expect(pausedKeys(sqlite).sort()).toEqual([...paused, ...siblings.map(mintBurnConfigKey)].sort());
        await proofFor(db, siblings[0], 1, later, 101, 200);
        expect((await readScope(db, later, roster)).configs).toEqual(roster);
        expect(pausedKeys(sqlite).sort()).toEqual(paused.sort());
      }
    },
  );

  it("compacts publication diagnostics while retaining exact admitted pairs and non-admitted reasons", async () => {
    const { db } = fixtures.open();
    const { publication } = await readContext(db, end, MINT_BURN_CONFIGS);
    const compact = compactMintBurnPublication(publication);
    expect(compact).toMatchObject({ legsScope: "non-admitted", legCount: MINT_BURN_CONFIGS.length,
      admittedCount: 134, pendingAdmissionCount: 2, disabledCount: 0 });
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
    expect((await readContext(db, end + 60, [config])).configs).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_admission").get()).toEqual({ n: 0 });
  });

  it("honors the ID, config-key, symbol and enabled switches through one ingestion authority", () => {
    expect(mintBurnDisabledReason(config, new Set([config.stablecoinId]), new Set())).toBe("id-disabled");
    expect(mintBurnDisabledReason(config, new Set([mintBurnConfigKey(config).toLowerCase()]), new Set())).toBe("id-disabled");
    expect(mintBurnDisabledReason(config, new Set(), new Set([config.symbol.toUpperCase()]))).toBe("symbol-disabled");
    expect(mintBurnDisabledReason({ ...config, enabled: false }, new Set(), new Set())).toBe("config-disabled");
  });

  it("honors a symbol switch only when the symbol names one stablecoin", () => {
    const idsBySymbol = new Map<string, Set<string>>();
    for (const entry of MINT_BURN_CONFIGS) {
      const symbol = entry.symbol.toUpperCase();
      const ids = idsBySymbol.get(symbol) ?? new Set<string>();
      ids.add(entry.stablecoinId);
      idsBySymbol.set(symbol, ids);
    }
    expect([...idsBySymbol.values()].some((ids) => ids.size > 1)).toBe(true);
    for (const [symbol, ids] of idsBySymbol) {
      expect(resolveMintBurnDisabledSymbols(MINT_BURN_CONFIGS, new Set([symbol])).has(symbol), symbol).toBe(ids.size === 1);
    }
  });

  it("retains prior durable keys for an ambiguous symbol and names why it was ignored", () => {
    const yusd = MINT_BURN_CONFIGS.filter((entry) => entry.symbol.toUpperCase() === "YUSD");
    const yusdKeys = yusd.map(mintBurnConfigKey);
    const resolution = resolveMintBurnDisabledSymbolPolicy(
      MINT_BURN_CONFIGS,
      new Set(["YUSD", "NOT-A-COIN"]),
      new Set([yusdKeys[0]!]),
    );
    expect([...resolution.symbols]).toEqual([]);
    expect([...resolution.retainedKeys]).toEqual([yusdKeys[0]]);
    expect(resolution.ignored).toEqual([
      { symbol: "NOT-A-COIN", reason: "unknown-symbol", stablecoinIds: [], retainedKeys: [] },
      {
        symbol: "YUSD",
        reason: "shared-symbol",
        stablecoinIds: [...new Set(yusd.map((entry) => entry.stablecoinId.toLowerCase()))].sort(),
        retainedKeys: [yusdKeys[0]],
      },
    ]);
  });

  it.each(["disabled", "inactive", "grandfathered"])("fences %s membership until reactivation catch-up", async (state) => {
    const { db, sqlite } = fixtures.open();
    const entry = state === "grandfathered" ? usdc : config;
    const entryKey = mintBurnConfigKey(entry), incumbentKey = mintBurnConfigKey(config);
    const roster = entry === config ? [config] : [config, entry];
    await proof(db, 90);
    expect((await readContext(db, end, [config])).configs).toEqual([config]);
    if (state === "grandfathered") {
      expect(isGrandfatheredMintBurnConfig(entry)).toBe(true);
      await proofFor(db, entry, 390, end - 10 * day);
    }
    const key = aggregateFlowCacheKey(24);
    sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(key, "{}", end);
    await syncMintBurnPublicationPolicy(db, state === "disabled" ? [entryKey] : [], end + 60,
      state === "disabled" ? undefined : state === "inactive" ? [] : [incumbentKey]);
    if (state === "disabled") {
      const disabled = await readContext(db, end + 61, roster);
      expect(disabled.configs).toEqual([]);
      expect(disabled.publication.legs[0].reason).toBe("operator-disabled");
      expect((await finalizeMintBurnFlowResponse(db, key, end + 62, {}, { status: "ok", timestamp: end }, "[]")).status).toBe(503);
      expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(key)).toBeUndefined();
    }
    await syncMintBurnPublicationPolicy(db, [], end + 120, roster.map(mintBurnConfigKey));
    const now = state === "grandfathered" ? end + 120 : end + day;
    const stale = await readContext(db, now, roster);
    expect(stale.configs).toEqual(entry === config ? [] : [config]);
    expect(stale.publication.legs.find((leg) => leg.configKey === entryKey))
      .toMatchObject({ status: "pending-admission", reason: "reactivation-pending" });
    if (state === "grandfathered") expect(stale.watermark).toMatchObject({ timestamp: end, ageSec: 120, unavailableReason: null });
    expect(pausedKeys(sqlite)).toContain(entryKey);
    await proofFor(db, entry, 1, Math.floor(now / 3600) * 3600, 101, 200);
    expect((await readContext(db, now + 60, roster)).configs).toEqual(roster);
    expect(pausedKeys(sqlite)).not.toContain(entryKey);
    expect((await readContext(db, end + 2 * day, roster)).configs).toEqual(roster);
  });

  it.each([false, true])("retains edited membership; isolates BUIDL with survivor=%s", async (survivor) => {
    const { db } = fixtures.open();
    const existing = byId("usdt-tether")[0];
    const revised = { ...existing, decimals: existing.decimals + 1, startBlock: existing.startBlock + 1 };
    expect(isGrandfatheredMintBurnConfig(revised)).toBe(true);
    expect((await readContext(db, end, [revised])).configs).toEqual([revised]);
    const siblings = byId("buidl-blackrock");
    for (const entry of siblings) await proofFor(db, entry, 90);
    const edited = siblings.map((entry, i) => i ? entry : { ...entry, decimals: entry.decimals + 1 });
    if (survivor) { await proof(db, 90); await readContext(db, end, [config]); }
    const scope = await readScope(db, end, [...edited, ...(survivor ? [config] : [])]);
    expect(scope.configs).toEqual(survivor ? [config] : edited);
    expect(scope.publication.legs.slice(0, 2).every((leg) => leg.status === (survivor ? "pending-admission" : "admitted"))).toBe(true);
  });

  it("holds a shared BUIDL bucket together during stale re-enable", async () => {
    const { db } = fixtures.open();
    const siblings = byId("buidl-blackrock");
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(siblings[0])], end);
    await syncMintBurnPublicationPolicy(db, [], end + day);
    const scope = await readContext(db, end + day, siblings);
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
    const legacy = byId("buidl-blackrock");
    expect(legacy).toHaveLength(2);
    const sibling = { ...legacy[0], contractAddress: `0x${"a".repeat(40)}` };
    const scope = await readContext(db, end, [...legacy, sibling]);
    expect(scope.configs).toEqual(legacy);
    expect(scope.diagnosticConfigs).toEqual(legacy);
    expect(scope.publication.legs[2].reason).toBe("unsupported-shared-bucket");
    await syncMintBurnPublicationPolicy(db, [mintBurnConfigKey(legacy[0])], end);
    const disabled = await readContext(db, end, legacy);
    expect(disabled.configs).toEqual([]);
    expect(disabled.diagnosticConfigs).toEqual([]);
    expect(disabled.publication.legs[1].reason).toBe("shared-bucket-disabled");
  });

  it("does not let a pending sibling change an incumbent's legacy coverage", async () => {
    const { db, sqlite } = fixtures.open();
    const legacy = byId("usdt-tether")[0];
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
    const before = await readContext(db, now, [legacy]);
    const sibling = { ...legacy, contractAddress: `0x${"a".repeat(40)}` };
    const after = await readContext(db, now, [legacy, sibling]);
    expect(before.legacy.get(key)?.start).toBe(MINT_BURN_LEGACY_CUTOVER - 30 * day);
    expect(after.legacy).toEqual(before.legacy);
    expect(after.watermark).toEqual(before.watermark);
  });

  it("keeps a quarantined grandfathered key readable after its operator switch is removed", async () => {
    const { db, sqlite } = fixtures.open();
    // Inactive coins retain per-coin history while pauses gate future re-admission.
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
    await syncMintBurnPublicationPolicy(db, [key], hourTs, activeKeys);
    await syncMintBurnPublicationPolicy(db, [], hourTs + 60, activeKeys);
    expect(sqlite.prepare("SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1").get())
      .toEqual({ disabled_keys: "[]" });
    expect(pausedKeys(sqlite)).toContain(key);

    const response = await handleMintBurnFlows(db, new URL(`https://x/api/mint-burn-flows?stablecoin=${quarantined.stablecoinId}`));
    const body = MintBurnPerCoinResponseSchema.parse(await readJsonResponse(response, 200));
    expect(body.chains.map((chain) => chain.chainId)).toEqual([quarantined.chain.chainId]);
    expect(body.mintCount).toBe(1);
    expect(body.mintVolumeUsd).toBe(1_000_000);
    expect(body.publication).toMatchObject({ admittedCount: 1, legs: [] });
  });

  it("fails closed on an undecodable paused_keys value instead of lifting a pause", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(`INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
      VALUES (1, '[]', 'not-json', ?)`).run(end);
    // An unreadable reactivation gate cannot lift a pause.
    await expect(readContext(db, end, [config])).rejects.toThrow("Invalid mint/burn publication policy");
    await expect(syncMintBurnPublicationPolicy(db, [], end + 60, [mintBurnConfigKey(config)])).rejects.toThrow();
    expect(sqlite.prepare("SELECT paused_keys FROM mint_burn_publication_policy WHERE id = 1").get())
      .toEqual({ paused_keys: "not-json" });
  });
});
