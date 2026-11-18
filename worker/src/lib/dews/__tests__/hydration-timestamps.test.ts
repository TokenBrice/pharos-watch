import { getReferenceSessionState } from "@shared/lib/reference-market-hours";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { hydrateDexLiquidity, hydrateDexLiquidityHistory, hydrateDexPrices, hydrateLatestPsiScore, hydrateMintBurn, hydrateYieldRankingsCache, hydrateYieldWarnings } from "../source-state/hydration";
import { DEWS_PSI_FRESHNESS_BUDGET_SEC, DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC } from "../source-state/budgets";
import { computeDEWS } from "../../dews";
import { makeDewsInput } from "../../__tests__/dews.test-support";
import { makeDexLiquidityRow } from "../../../test-helpers/__shared/fixtures";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { loadDewsSourceState } from "../source-state";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { resolveCronTimeoutBudget } from "../../cron-timeouts";
import { aggregateFlowCacheKey } from "../../mint-burn-flow-cache-keys";
import { getMintBurnConfigsForStablecoin, MINT_BURN_CONFIGS } from "../../mint-burn-contracts";
import { mintBurnConfigKey } from "../../mint-burn-contract-identity";
import { commitMintBurnMaterializedCoverage, decodeMintBurnScanCoverage, mintBurnScanCoverageAdmits, mintBurnScanCoverageStatements, mintBurnScanFingerprint, prepareMintBurnWriterEpochCoverage, type MintBurnScanSegment } from "../../mint-burn-pipeline/scan-coverage";
import { computeFlowSignal, computeYieldSignal } from "../signal-families";
import { assembleDewsScoringInput, loadDewsNativeHistory } from "../input-assembly";
import type { StablecoinData } from "@shared/types/supply";

function dexClock(asOfSec: number): string {
  const clock = { asOfSec, maxObservationAgeSec: 3600 };
  return JSON.stringify({ "24h": summarizeDexVolumeWindow([], "24h", clock).availability, "7d": summarizeDexVolumeWindow([], "7d", clock).availability });
}

const RUN_AT = 1_800_000_000;
const YIELD_BUDGET_SEC = CRON_INTERVALS["sync-yield-data"]
  + resolveCronTimeoutBudget("sync-yield-data").configuredTimeoutMs / 1000;
afterEach(() => vi.useRealTimers());

describe("DEWS hydration timestamp admission", () => {
  it.each(["ethereum", "tron", "both", "gap", "debt", "unpriced", "unresolved", "fingerprint", "disabled"])(
    "proves each admitted USDT chain during isolation: %s", async (state) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const end = Math.floor(RUN_AT / 3600) * 3600;
      const configs = getMintBurnConfigsForStablecoin("usdt-tether");
      try {
        insertAdmittedMintBurnGauge(sqlite, end, RUN_AT);
        const value = JSON.parse(sqlite.prepare("SELECT value FROM cache").get()!.value as string);
        value.coins[0].coverage.windows.window24h = { complete: false, unavailableReason: "scan-coverage-incomplete" };
        value.publication.legs = configs.map((config) => {
          const admitted = state !== "both" && (state === "ethereum" ? config.chain.chainId === "tron" : config.chain.chainId === "ethereum");
          return { ...value.publication.legs[0],
          configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
          status: admitted ? "admitted" : "pending-admission", reason: admitted ? null : "reactivation-pending" };
        });
        if (state === "disabled") value.publication.legs[0].status = "disabled";
        if (state === "fingerprint") value.publication.legs[1].configFingerprint = "old";
        sqlite.prepare("UPDATE cache SET value = ?").run(JSON.stringify(value));
        const chainId = state === "ethereum" ? "tron" : "ethereum";
        const config = configs.find((c) => c.chain.chainId === chainId)!;
        await db.batch(mintBurnScanCoverageStatements(db, { configKey: mintBurnConfigKey(config),
          configFingerprint: mintBurnScanFingerprint(config), chainId, fromBlock: 1, toBlock: 2,
          fromTimestamp: end - (state === "gap" ? 29 : 30) * 86400, toTimestamp: end,
          finalizedBlock: 2, acceptedAt: end }));
        insertBurnHour(sqlite, end - 3600, chainId);
        if (state === "debt") sqlite.prepare("INSERT INTO mint_burn_dirty_hours VALUES ('usdt-tether', 'ethereum', ?)").run(end - 3600);
        if (state === "unpriced") sqlite.exec("UPDATE mint_burn_hourly SET burn_unpriced_event_count = 1");
        if (state === "unresolved") sqlite.exec("UPDATE mint_burn_hourly SET burn_unresolved_event_count = 1");
        const result = await hydrateMintBurn({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
        const snapshot = result.mintBurnMap.get("usdt-tether");
        if (["ethereum", "tron", "unpriced"].includes(state)) {
          expect(snapshot).toMatchObject({ scope: "partial-admitted-chains", chainIds: [chainId], burn24h: 700000,
            valuation24h: state === "unpriced" ? "partial" : "complete" });
        } else expect(snapshot).toBeUndefined();
      } finally { sqlite.close(); }
    });
  it.each(["missing", "scope-missing", "scope-missing-disabled", "scope-missing-new", "pending", "disabled", "incomplete", "wrong-window", "quiet", "eventful", "compact", "compact-missing-pairs", "materialization-debt", "classification-unresolved", "classification-unknown"] as const)(
    "keeps mint/burn scan admission distinct from observed data: %s", async (state) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const end = Math.floor(RUN_AT / 3600) * 3600;
      const configIndex = MINT_BURN_CONFIGS.findIndex((config) => config.stablecoinId === "usdt-tether");
      const originalConfig = MINT_BURN_CONFIGS[configIndex];
      try {
        if (state !== "missing") {
          const window = { complete: state !== "incomplete", unavailableReason: state === "incomplete" ? "scan-coverage-incomplete" : null };
          const value = { gauge: { score: null }, updatedAt: end,
            ...(state.startsWith("scope-missing") ? {} : { publication: {
              evaluatedAt: RUN_AT, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 7200,
              legs: [{ configKey: "synthetic", configFingerprint: "synthetic-v1", stablecoinId: "usdt-tether", chainId: "ethereum",
                status: state === "pending" ? "pending-admission" : state === "disabled" ? "disabled" : "admitted",
                reason: state === "pending" ? "baseline-incomplete" : state === "disabled" ? "operator-disabled" : null,
                admittedAt: null, baselineFrom: end - 90 * 86400, baselineTo: end, coveredSeconds: 90 * 86400, frontierAgeSec: 0 }],
              ...(state.startsWith("compact") ? { legsScope: "non-admitted", legs: [],
                ...(state === "compact" ? { admittedPairs: [["usdt-tether", "ethereum"], ["usdt-tether", "tron"]] } : {}) } : {}),
            } }),
            window: { start: end - 86400, end: state === "wrong-window" ? end - 3600 : end, semantics: "closed-utc-hours" },
            coins: [{ stablecoinId: "usdt-tether", symbol: "USDT", pressureShiftScore: null, netFlow24hUsd: null,
              coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: end - 90 * 86400,
                has24hWindow: state !== "incomplete", has30dWindow: true, has90dWindow: true, isPartial: false, status: "full",
                windows: { window24h: window, window7d: window, window30d: window, window90d: window } } }] };
          sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(aggregateFlowCacheKey(24), JSON.stringify(value), RUN_AT);
        }
        if (state === "compact") insertBurnHour(sqlite, end - 3600, "tron", 100_000_000);
        if (["eventful", "compact-missing-pairs", "missing", "incomplete", "pending", "disabled"].includes(state) || state.startsWith("scope-missing")) {
          insertBurnHour(sqlite, end - 3600);
        }
        if (state === "classification-unknown") {
          MINT_BURN_CONFIGS[configIndex] = { ...originalConfig,
            bridgeDetection: getMintBurnConfigsForStablecoin("eurc-circle")[0].bridgeDetection };
        }
        if (state === "classification-unresolved" || state === "classification-unknown") {
          sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
            mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
            VALUES ('usdt-tether', 'ethereum', ?, 1, 0, 0, 0, 700000, 0, 700000)`).run(end - 3600);
          if (state === "classification-unresolved") sqlite.exec("UPDATE mint_burn_hourly SET mint_unresolved_event_count = 0, burn_unresolved_event_count = 1");
        }
        if (state === "materialization-debt") {
          sqlite.prepare("INSERT INTO mint_burn_dirty_hours (stablecoin_id, chain_id, hour_ts) VALUES ('usdt-tether', 'ethereum', ?)")
            .run(end - 3600);
        }
        if (state === "scope-missing-disabled") {
          sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
            .run(JSON.stringify(getMintBurnConfigsForStablecoin("usdt-tether").map(mintBurnConfigKey)), RUN_AT);
        }
        if (state === "scope-missing-new") {
          MINT_BURN_CONFIGS[configIndex] = { ...originalConfig, contractAddress: "0x9999999999999999999999999999999999999999" };
        }
        const hydrated = await hydrateMintBurn({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
        const snapshot = hydrated.mintBurnMap.get("usdt-tether");
        if (state === "quiet" || state === "eventful" || state === "compact" || state === "scope-missing") {
          const burn = state === "compact" ? 100_000_000 : state === "quiet" ? 0 : 700_000;
          const chainIds = state === "compact" ? ["ethereum", "tron"] : ["ethereum"];
          expect(snapshot).toMatchObject({ burn24h: burn, baselineDays: 30, burnBaseline: burn / 30, chainIds,
            scope: state === "compact" ? "all-admitted-chains" : "partial-admitted-chains" });
          const signal = computeFlowSignal(makeDewsInput({ burnVolume24hUsd: burn, mintVolume24hUsd: 0,
            burnBaseline30dUsd: burn / 30, flowBaselineDays: 30, flowHolderPressureWithheld: true,
            flowScope: snapshot!.scope, flowChainIds: snapshot!.chainIds, flowEpochIssue: snapshot!.epochIssue }));
          expect(signal).toMatchObject({ available: false, burnVolume24hUsd: burn, flowChainIds: chainIds,
            unavailableReason: "mint-burn-usdt-holder-pressure-unavailable" });
          expect(signal.net24hUsd).toBeUndefined();
        } else expect(snapshot).toBeUndefined();
      } finally {
        MINT_BURN_CONFIGS[configIndex] = originalConfig;
        sqlite.close();
      }
    },
  );
  it.each(["2026-11-10T08:00:00Z", "2026-11-10T09:00:00Z", "2026-12-10T09:00:00Z"])(
    "uses legacy flow for an empty epoch table regardless of the historical date %s", async (when) => {
      const { sqlite, db } = createLatestSchemaSqlite();
      const end = Date.parse(when) / 1000;
      try {
        insertAdmittedMintBurnGauge(sqlite, end, end);
        const hydrated = await hydrateMintBurn({ db, nowSec: end, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
        expect(hydrated.mintBurnMap.get("usdt-tether")).toBeDefined();
        expect(hydrated.mintBurnMap.get("usdt-tether")?.epochIssue).toBeUndefined();
      } finally { sqlite.close(); }
  });

  it("preserves the hours on either side of a legacy rewrite, including a partial scan boundary", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600;
    const config = getMintBurnConfigsForStablecoin("usdc-circle").find((leg) => leg.chain.chainId === "ethereum")!;
    const configKey = mintBurnConfigKey(config);
    const proof = { configKey, configFingerprint: mintBurnScanFingerprint(config), chainId: "ethereum",
      materializedStablecoinId: config.stablecoinId, fromBlock: 1, toBlock: 10,
      fromTimestamp: end - 60 * 86400, toTimestamp: end + 1800, finalizedBlock: 20, acceptedAt: end + 7200 };
    const admits = async (start: number, stop: number) => mintBurnScanCoverageAdmits([config], decodeMintBurnScanCoverage(
      await prepareMintBurnWriterEpochCoverage(db, [config], start, stop).all<MintBurnScanSegment>()), start, stop);
    try {
      await commitMintBurnMaterializedCoverage(db, proof, []);
      await commitMintBurnMaterializedCoverage(db, proof, []);
      sqlite.prepare("INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts) VALUES (?, 'ethereum', ?)").run(config.stablecoinId, end);
      await commitMintBurnMaterializedCoverage(db, {
        ...proof, fromBlock: 11, toBlock: 20, fromTimestamp: end + 1810, toTimestamp: end + 3600,
      }, []);
      expect(await admits(end, end + 3600)).toBe(false);
      expect(await admits(end - 86400, end)).toBe(true);

      const dirty = end - 75 * 3600;
      await db.batch([
        db.prepare("INSERT INTO mint_burn_dirty_hours VALUES (?, 'ethereum', ?)").bind(config.stablecoinId, dirty),
        db.prepare("DELETE FROM mint_burn_dirty_hours WHERE stablecoin_id = ? AND hour_ts = ?").bind(config.stablecoinId, dirty),
      ]);
      expect(await admits(dirty, dirty + 3600)).toBe(false);
      expect(await admits(proof.fromTimestamp, dirty)).toBe(true);
      expect(await admits(dirty + 3600, end)).toBe(true);
      expect(sqlite.prepare("SELECT from_block, to_block FROM mint_burn_writer_epoch_coverage").all()).toEqual([{ from_block: 1, to_block: 20 }]);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mint_burn_scan_coverage WHERE config_key = ?").get(configKey)).toEqual({ n: 1 });
    } finally { sqlite.close(); }
  });

  it("invalidates the oldest burn included by a gauge one hour behind wall time", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const wall = Math.floor(RUN_AT / 3600) * 3600;
    const end = wall - 3600;
    const start = end - 30 * 86400;
    const id = "usdc-circle";
    try {
      sqlite.function("unixepoch", () => wall);
      insertAdmittedMintBurnGauge(sqlite, end, wall, id);
      sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_unresolved_event_count, burn_unresolved_event_count,
        mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES (?, 'ethereum', ?, 0, 1, 0, 0, 0, 0, 0, 10000, -10000)`).run(id, start);
      sqlite.prepare("UPDATE mint_burn_writer_epoch_hours SET writer_epoch = 'holder-accounting-v2', revision = 'original' WHERE hour_ts = ?").run(start);
      for (const config of getMintBurnConfigsForStablecoin(id).filter((leg) => leg.chain.chainId === "ethereum")) {
        await commitMintBurnMaterializedCoverage(db, { configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config),
          chainId: "ethereum", materializedStablecoinId: id, fromBlock: 1, toBlock: 10, fromTimestamp: start, toTimestamp: end,
          finalizedBlock: 10, acceptedAt: end }, []);
      }
      const hydrate = async () => (await hydrateMintBurn({ db, nowSec: wall, registerSourceFailure: vi.fn(),
        registerMalformedPersistedInput: vi.fn() })).mintBurnMap.get(id);
      expect(await hydrate()).toMatchObject({ epochIssue: null, burnBaseline: 10000 / 30 });
      sqlite.prepare("DELETE FROM mint_burn_hourly WHERE stablecoin_id = ? AND hour_ts = ?").run(id, start);
      expect(await hydrate()).toMatchObject({ epochIssue: "mint-burn-accounting-epoch-missing" });
    } finally { sqlite.close(); }
  });

  it.each([
    ["comparable", null, "older", "older", 24, true],
    ["mixed baseline", "mint-burn-accounting-epoch-mixed", "older", "newer", 24, true],
    ["legacy baseline", null, null, "newer", 24, true],
    ["legacy hour rewritten after activation", "mint-burn-accounting-epoch-missing", "rewrite", "newer", 24, true],
    ["gap after activation in baseline", "mint-burn-accounting-epoch-missing", "gap", "newer", 24, true],
    ["mixed current window", "mint-burn-current-accounting-epoch-mixed", "older", "newer", 12, false],
    ["legacy current hours", null, null, "newer", 12, true],
    ["gap after activation in current window", "mint-burn-current-accounting-epoch-missing", "gap", "newer", 12, false],
    ["no recent proof after activation", "mint-burn-current-accounting-epoch-missing", "gap", null, 24, false],
  ] as const)("requires one writer epoch across complete finalized scans (%s)", async (_mode, reason, firstEpoch, lastEpoch, splitHours, available) => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600;
    const id = "usdc-circle";
    try {
      insertAdmittedMintBurnGauge(sqlite, end, RUN_AT, id);
      if (lastEpoch) {
        sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
          mint_unpriced_event_count, burn_unpriced_event_count, mint_unresolved_event_count, burn_unresolved_event_count,
          mint_volume_usd, burn_volume_usd, net_flow_usd)
          VALUES (?, 'ethereum', ?, 1, 1, 0, 0, 0, 0, 100000, 700000, -600000)`).run(id, end - 3600);
        sqlite.prepare("UPDATE mint_burn_writer_epoch_hours SET writer_epoch = ?, revision = 'fixture' WHERE hour_ts = ?").run(lastEpoch, end - 3600);
      }
      const write = sqlite.prepare(`INSERT INTO mint_burn_writer_epoch_coverage
        VALUES (?, ?, 'ethereum', ?, ?, ?, ?, ?, ?)`);
      const boundary = end - splitHours * 3600;
      for (const config of getMintBurnConfigsForStablecoin(id).filter((leg) => leg.chain.chainId === "ethereum")) {
        const key = mintBurnConfigKey(config);
        const fingerprint = mintBurnScanFingerprint(config);
        if (firstEpoch === "gap") write.run(key, fingerprint, id, "newer", 1, 10, end - 40 * 86400, end - 39 * 86400);
        else if (firstEpoch && firstEpoch !== "rewrite") write.run(key, fingerprint, id, firstEpoch, 1, 10, end - 30 * 86400, boundary);
        if (lastEpoch) write.run(key, fingerprint, id, lastEpoch, 11, 20, boundary, end);
      }
      if (firstEpoch === "rewrite") {
        sqlite.prepare("INSERT INTO mint_burn_writer_epoch_hours (stablecoin_id, chain_id, hour_ts) VALUES (?, 'ethereum', ?)")
          .run(id, boundary - 3600);
      }
      const state = await hydrateMintBurn({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() });
      const flow = state.mintBurnMap.get(id);
      expect(flow?.epochIssue).toBe(reason);
      expect(flow?.baselineDays).toBe(30);
      const signal = computeFlowSignal(makeDewsInput({ stablecoinId: id, flowEpochIssue: flow?.epochIssue,
        burnVolume24hUsd: flow?.burn24h, mintVolume24hUsd: flow?.mint24h, burnBaseline30dUsd: flow?.burnBaseline, flowBaselineDays: 30 }));
      expect(signal).toMatchObject({ available, burnVolume24hUsd: lastEpoch ? 700_000 : 0, mintVolume24hUsd: lastEpoch ? 100_000 : 0 });
      if (!available) {
        expect(signal).toMatchObject({ unavailableReason: reason, value: 0 });
        expect(signal).not.toHaveProperty("burnToMintRatio");
      } else if (reason) expect(signal).toMatchObject({ burnToMintRatio: 7, burnSurgeUnavailableReason: reason, componentCoverage: 0.4 });
      else expect(signal.burnSurge).toBe(30);
    } finally { sqlite.close(); }
  });

  it("selects only same-perimeter native history on the requested dates", async () => {
    const day = Date.parse("2026-11-15T00:00:00Z") / 1000;
    const asset = (id: string, circulatingNative?: number | null) => ({ id, circulatingNative, supplyObservedAt: day + 60, supplySource: "onchain-circulating-supply" }) as StablecoinData;
    const db = mockD1([{ match: "pharos:dews:native-supply-history", rows: [
      { stablecoin_id: "xaut-tether", snapshot_date: day - 86400, circulating_native: 809_363 },
      { stablecoin_id: "xaut-tether", snapshot_date: day - 86400 * 7, circulating_native: 809_381 },
      { stablecoin_id: "xaut-tether", snapshot_date: day - 2 * 86400, circulating_native: 1 },
      { stablecoin_id: "gho-aave", snapshot_date: day - 7 * 86400, circulating_native: 50 },
      { stablecoin_id: "gho-aave", snapshot_date: day - 86400, circulating_native: 0 },
      { stablecoin_id: "usdt-tether", snapshot_date: day - 86400, circulating_native: 100 },
    ].map((row) => ({ ...row, supply_provenance: JSON.stringify({ supplySource: "onchain-circulating-supply",
      supplyObservedAt: row.snapshot_date, supplyChainGuard: null }) })) }]);
    const results = await loadDewsNativeHistory(db, [asset("xaut-tether", 809_363), asset("gho-aave", 5),
      asset("usdt-tether", null), asset("usdc-circle")], day + 180);
    expect(Object.fromEntries(results)).toEqual({
      "xaut-tether": { day: 809_363, week: 809_381 },
      "gho-aave": { day: 0, week: null },
      "usdt-tether": { day: null, week: null },
    });
  });

  it.each([[30, true], [90, false], [undefined, false]] as const)("checks asset clock offset %s against the DEWS read", async (offset, admitted) => {
    const asset = { id: "xaut-tether", circulatingNative: 809_363,
      supplySource: "onchain-circulating-supply", supplyObservedAt: offset == null ? undefined : RUN_AT + offset } as StablecoinData;
    const day = Math.floor(RUN_AT / 86400) * 86400;
    const db = mockD1([{ match: "pharos:dews:native-supply-history", rows: [
      { stablecoin_id: asset.id, snapshot_date: day - 86400, circulating_native: 809_363 },
      { stablecoin_id: asset.id, snapshot_date: day - 7 * 86400, circulating_native: 809_381 },
    ].map((row) => ({ ...row, supply_provenance: JSON.stringify({ supplySource: "onchain-circulating-supply",
      supplyObservedAt: row.snapshot_date, supplyChainGuard: null }) })) }]);
    const anchors = await loadDewsNativeHistory(db, [asset], RUN_AT + 60);
    expect(anchors.get(asset.id)).toEqual(admitted ? { day: 809_363, week: 809_381 } : offset == null ? undefined : { day: null, week: null });
  });

  it("keeps equal rates attached to the clock and source of each accepted selection", async () => {
    const pegKey = "peggedEUR";
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const publish = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
      publish.run("fx-rates", JSON.stringify({ [pegKey]: 1.1 }), RUN_AT);
      const opened = getReferenceSessionState("fx", RUN_AT).sessionOpenedAtSec!;
      for (const [clock, source, session, generationShift] of [
        [RUN_AT - 120, "chainlink", opened, 0],
        [RUN_AT - 60, "openExchangeRates", opened - 7 * 86400, 0],
        [RUN_AT, "openExchangeRates", opened, -1],
      ] as const) {
        const generation = `stablecoins:${clock + generationShift}`;
        publish.run("stablecoins", JSON.stringify({ peggedAssets: [{ id: "eurc-circle", symbol: "EURC", pegType: pegKey }],
          fxReferenceObservations: {}, fxFallbackRates: { [pegKey]: 1.1 }, selectedPegReferences: { [pegKey]: {
            kind: "fx", generation, observation: { pegKey, source, cadence: "intraday", usdPerUnit: 1.1, observedAtSec: clock },
            repricing: { source, sessionOpenedAtSec: session, preCloseUsdPerUnit: 1.2 },
          } } }), clock);
        const result = await assembleDewsScoringInput({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(),
          registerMalformedPersistedInput: vi.fn() });
        expect(result.kind).toBe("ok");
        if (result.kind !== "ok") continue;
        const selection = result.sourceState.references?.get(pegKey);
        if (generationShift !== 0) {
          expect(selection).toBeUndefined();
          continue;
        }
        expect(selection).toMatchObject({ kind: "fx", generation, usdPerUnit: 1.1, observation: { observedAtSec: clock, source } });
        expect(selection?.kind === "fx" ? selection.preCloseUsdPerUnit : undefined).toBe(session === opened ? 1.2 : undefined);
      }
    } finally { sqlite.close(); }
  });

  it.each([["fresh", false], ["stale", true], ["unknown", false], [undefined, false]] as const)(
    "uses the selected row's %s cadence verdict independently of a seven-hour raw age", async (sourceFreshness, overdue) => {
      vi.useFakeTimers();
      vi.setSystemTime(RUN_AT * 1000);
      const state = await hydrateYieldRankingsCache({
        db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
          updated_at: RUN_AT, value: JSON.stringify({ rankings: [{ id: "a7a5-a7a5",
            provenance: { sourceFreshness }, sourceRisk: { sourceAgeSeconds: 7 * 3600 } }] }),
        } }]),
        nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      });
      const signal = computeYieldSignal(makeDewsInput({ yieldSourceRisk: state.yieldSourceRisk.get("a7a5-a7a5"),
        yieldSourceOverdue: state.overdueSourceIds?.has("a7a5-a7a5") }));
      expect(signal).toMatchObject({ available: overdue, value: overdue ? 15 : 0, sourceAgeSeconds: 7 * 3600 });
    },
  );
  it.each([
    ["valid", RUN_AT, 0, null],
    ["inclusive budget", RUN_AT - YIELD_BUDGET_SEC, 0, null],
    ["retained last-good", RUN_AT - YIELD_BUDGET_SEC - 1, 0, null],
    ["inclusive retention budget", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC, 0, null],
    ["stale", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC - 1, 0, "exceeds"],
    ["run/read overlap", RUN_AT + 120, 120, null],
    ["inclusive read skew", RUN_AT + 180, 120, null],
    ["beyond read skew", RUN_AT + 181, 120, "future-timestamp"],
    ["one day future", RUN_AT + 86400, 0, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, 0, "invalid-timestamp"],
    ["missing", null, 0, "missing-timestamp"],
  ] as const)("holds inadmissible %s yield clocks without discarding readable diagnostics", async (_label, updatedAt, readOffset, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + readOffset) * 1000);
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: updatedAt,
        value: JSON.stringify({ rankings: [{
          id: "usdt-tether", sourceRisk: { rewardShare: 0.9 },
          rankChangeAttribution: { rankDelta: -5, primaryDriver: "source-risk" },
        }] }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.yieldSourceRisk.get("usdt-tether")?.rewardShare).toBe(0.9);
    expect(hydrated.yieldRankChangeAttribution.get("usdt-tether")).toMatchObject({
      rankDelta: -5, primaryDriver: "source-risk",
    });
    if (reason == null) {
      expect(registerSourceFailure).not.toHaveBeenCalled();
    } else {
      expect(registerSourceFailure).toHaveBeenCalledTimes(1);
      expect(registerSourceFailure).toHaveBeenCalledWith("yield-rankings-freshness", expect.stringContaining(reason));
    }
  });

  it.each([
    ["fresh", RUN_AT - YIELD_BUDGET_SEC, YIELD_BUDGET_SEC, false, null],
    ["retained", RUN_AT - YIELD_BUDGET_SEC - 1, YIELD_BUDGET_SEC + 1, true, "retained-last-good"],
    ["stale", RUN_AT - DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC - 1, null, false, "stale-generation"],
  ] as const)("names the %s yield-rankings generation, age and retention budget", async (_label, updatedAt, ageSec, retained, reason) => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: updatedAt,
        value: JSON.stringify({ rankings: [{ id: "usdt-tether", sourceRisk: { rewardShare: 0.9 } }] }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.yieldRankingsAgeSec).toBe(ageSec);
    expect(hydrated.yieldRankingsRetained).toBe(retained);
    expect(hydrated.dependencyDiagnostics).toEqual({
      generationId: `yield-rankings:${updatedAt}`,
      updatedAt,
      ageSeconds: RUN_AT - updatedAt,
      freshnessBudgetSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC,
      reason,
    });
  });

  it.each([
    ["fresh", RUN_AT, null],
    ["boundary", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC, null],
    ["stale", RUN_AT - DEWS_PSI_FRESHNESS_BUDGET_SEC - 1, "stale-sample"],
    ["future", RUN_AT + 61, "future-timestamp"],
    ["invalid", Number.POSITIVE_INFINITY, "invalid-timestamp"],
    ["missing", null, "missing-sample"],
  ] as const)("admits PSI %s with the original sample clock and budget", async (_label, storedAt, reason) => {
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateLatestPsiScore({
      db: mockD1([{ match: "stability_index_samples", rows: [], first: storedAt == null ? null : { score: 0, stored_at: storedAt } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(hydrated.latestPsiScore).toBe(reason == null ? 0 : null);
    expect(hydrated.dependencyDiagnostics).toMatchObject({
      updatedAt: storedAt != null && Number.isFinite(storedAt) ? storedAt : null, freshnessBudgetSec: DEWS_PSI_FRESHNESS_BUDGET_SEC, reason,
    });
    expect(registerSourceFailure).not.toHaveBeenCalled();
    const scored = computeDEWS(makeDewsInput({ dexPriceUsd: 0.99, psiScore: hydrated.latestPsiScore }));
    expect(scored?.amplifiers.psi).toBe(reason == null ? 1.3 : 1);
  });
  it("admits an overlapping publication but excludes clocks beyond read-time skew", async () => {
    vi.useFakeTimers();
    vi.setSystemTime((RUN_AT + 120) * 1000);
    const row = (stablecoin_id: string, updated_at: number) => ({
      stablecoin_id, updated_at, weighted_balance_ratio: 0.9, avg_pool_stress: 0,
      top_pools_json: "[]", liquidity_score: 80, total_tvl_usd: 1_000_000,
    });
    const db = mockD1([
      { match: "SELECT stablecoin_id, weighted_balance_ratio", rows: [
        row("overlap", RUN_AT + 120), row("allowed", RUN_AT + 180), row("future", RUN_AT + 181),
      ] },
      { match: "FROM dex_liquidity_publication_generations", rows: [], first: null },
    ]);
    const hydrated = await hydrateDexLiquidity({
      db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    });
    expect([...hydrated.dexLiqMap.keys()]).toEqual(["overlap", "allowed"]);
    expect([...hydrated.dexLiqStaleIds]).toEqual(["future"]);
  });

  it.each([
    [0.5, 100, 36 * 3600, true],
    [0.499, 100, 36 * 3600, false],
    [null, 100, 36 * 3600, false],
    [0.5, 0, 36 * 3600, false],
    [0.5, 100, 36 * 3600 + 1, false],
  ])("admits weekly history confidence=%s TVL=%s distance=%s", async (confidence, tvl, distance, admitted) => {
    const target = RUN_AT - 7 * 86400;
    const db = mockD1([{ match: "FROM dex_liquidity_history", rows: [
      { stablecoin_id: "test", snapshot_date: target - distance, liquidity_score: 73, total_tvl_usd: tvl, coverage_confidence: confidence, methodology_version: null },
      { stablecoin_id: "test", snapshot_date: target, liquidity_score: 99, total_tvl_usd: 1000, coverage_confidence: 0.49, methodology_version: null },
    ] }]);
    const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn() },
      new Map([["test", makeDexLiquidityRow({ stablecoin_id: "test" })]]));
    expect(hydrated.liqHist7dMap.get("test")).toEqual(admitted ? { score: 73, tvl: null, date: target - distance } : undefined);
    expect(db.getHistory()[0].binds).toEqual([RUN_AT - 8.5 * 86400]);
    expect(db.getHistory()[0].sql).toContain("coverage_confidence");
  });

  it("fetches the older daily bucket at the inclusive live 8.5-day bound", async () => {
    const { db, sqlite } = createLatestSchemaSqlite();
    try {
      sqlite.exec(`INSERT INTO dex_liquidity_history
        (stablecoin_id,snapshot_date,liquidity_score,total_tvl_usd,coverage_confidence)
        VALUES ('daily',1727308800,80,100,0.5),('old',1727308799,80,100,0.5)`);
      const hydrated = await hydrateDexLiquidityHistory({ db, nowSec: 1728043200, registerSourceFailure: vi.fn(),
        registerMalformedPersistedInput: vi.fn() }, new Map(["daily", "old"].map(id =>
        [id, makeDexLiquidityRow({ stablecoin_id: id })])));
      expect(hydrated.liqHistRowsRead).toBe(1);
      expect([...hydrated.liqHist7dMap]).toEqual([["daily", { score: 80, tvl: null, date: 1727308800 }]]);
    } finally { sqlite.close(); }
  });

  it.each([
    ["6.95", "6.92", null],
    ["6.95", "6.94", 100],
    ["6.92", "6.92", 100],
    ["3.2", "3.1", 100],
  ] as const)("hydrates history against the stored current version %s, not runtime (%s)", async (current, historical, tvl) => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const { sqlite, db } = createLatestSchemaSqlite();
    const date = RUN_AT - 7 * 86400;
    try {
      sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, liquidity_score, updated_at, methodology_version, volume_availability_json) VALUES ('usdt-tether', 'USDT', 200, 80, ?, ?, ?)")
        .run(RUN_AT, current, dexClock(RUN_AT - 1800));
      sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, liquidity_score, snapshot_date, coverage_class, coverage_confidence, methodology_version, volume_availability_json) VALUES ('usdt-tether', 100, 73, ?, 'primary', 0.9, ?, ?)")
        .run(date, historical, dexClock(date - 1800));
      const hydrated = await loadDewsSourceState({
        db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.dexLiquidity.dexLiqMap.get("usdt-tether")?.methodology_version).toBe(current);
      expect(hydrated.liquidityHistory.liqHist7dMap.get("usdt-tether")).toEqual({ score: 73, tvl, date });
    } finally {
      sqlite.close();
    }
  });

  it.each(["legacy", "absent-current", "omitted-current", "omitted-history"] as const)(
    "retains independent historical scores while distinguishing %s identity", async (identity) => {
      const current = { ...makeDexLiquidityRow(), methodology_version: null as string | null };
      const history = { stablecoin_id: "usdt-tether", total_tvl_usd: 100, liquidity_score: 73,
        snapshot_date: RUN_AT - 7 * 86400, coverage_class: "primary", coverage_confidence: 0.9,
        methodology_version: null };
      if (identity === "omitted-current") Reflect.deleteProperty(current, "methodology_version");
      if (identity === "omitted-history") Reflect.deleteProperty(history, "methodology_version");
      const hydrated = await hydrateDexLiquidityHistory({
        db: mockD1([{ match: "FROM dex_liquidity_history", rows: [history] }]),
        nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
      }, identity === "absent-current" ? new Map() : new Map([["usdt-tether", current]]));
      expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({
        score: 73, tvl: null, date: history.snapshot_date,
      });
    },
  );

  it("chooses TVL by the served capture clock, ignoring unclocked and later observations", async () => {
    const capture = RUN_AT - 3600;
    const date = RUN_AT - 7 * 86400;
    const observation = { stablecoin_id: "usdt-tether", liquidity_score: 80, coverage_class: "primary",
      coverage_confidence: 0.9, methodology_version: "6.95" };
    const hydrated = await hydrateDexLiquidityHistory({
      db: mockD1([{ match: "FROM dex_liquidity_history", rows: [
        { ...observation, snapshot_date: date, total_tvl_usd: 1000 },
        { ...observation, snapshot_date: date - 86400, total_tvl_usd: 200, volume_availability_json: dexClock(date - 3600) },
        { ...observation, snapshot_date: date - 2 * 86400, total_tvl_usd: 500, volume_availability_json: dexClock(capture + 1) },
      ] }]), nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput: vi.fn(),
    }, new Map([["usdt-tether", makeDexLiquidityRow({ updated_at: RUN_AT, methodology_version: "6.95",
      volume_availability_json: dexClock(capture) })]]));
    expect(hydrated.liqHist7dMap.get("usdt-tether")).toEqual({ score: 80, tvl: 200, date });
  });

  it("hydrates only trusted fresh dex prices and never turns a failed read into a zero count", async () => {
    const registerMalformedPersistedInput = vi.fn();
    const db = mockD1([{ match: "FROM dex_prices", rows: ([
        ["trusted", 60, 2e6, 1], ["old", 36_000, 2e6, 1], ["thin", 60, 10, 1],
        ["crash", 60, 5_000_000, 1],
        ["boundary", 4500, 2e6, 1], ["missing", null, 2e6, 1],
        ["stale-publication", 60, 2e6, 36_000], ["invalid-publication", 60, 2e6, null],
        ["malformed", "{", 2e6, 1],
        ["future", -1, 2e6, 1], ["invalid", RUN_AT, 2e6, 1],
      ] as const).map(([id, age, tvl, publicationAge]) => ({
        stablecoin_id: id, dex_price_usd: id === "crash" ? 0.4 : 1, source_total_tvl: tvl,
        updated_at: publicationAge == null ? null : RUN_AT - publicationAge,
        price_sources_json: typeof age === "string" ? age :
          JSON.stringify(id === "crash" ? { aggregateObservedAt: RUN_AT - 60, sources: [] } :
            [["curve", 60, 2e6], ["mento", 60, 2e6], [null, 60, 2e6], ["curve", 2200, 2e6], ["curve", -0.5, 2e6], ["curve", 60, 10]].map(([protocol, sourceAge, tvl]) => ({
              protocol, price: 0.98, tvl, observedAt: RUN_AT - Number(sourceAge), aggregateObservedAt: age == null ? null : RUN_AT - age }))),
      })) }]);
    const hydrated = await hydrateDexPrices({
      db, nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput,
    });
    expect(db.getHistory()[0].sql).toContain("price_sources_json");
    expect(registerMalformedPersistedInput.mock.calls.map(([row]) => [row.stablecoinId, row.reason, row.degradesRun]))
      .toEqual([["missing", "aggregate-clock-unavailable", false], ["malformed", "json-parse-failed", false],
        ["future", "aggregate-clock-future", false], ["invalid", "aggregate-clock-invalid", false]]);
    expect([...hydrated.dexPriceMap]).toEqual([
      ["trusted", { dexPriceUsd: 1, sourceTotalTvl: 2_000_000, updatedAt: RUN_AT - 60,
        independentPrices: [0.98], independentQuotes: [{ price: 0.98, observedAtSec: RUN_AT - 60 }] }],
      ["crash", { dexPriceUsd: 0.4, sourceTotalTvl: 5_000_000, updatedAt: RUN_AT - 60 }],
    ]);
    expect(hydrated.trustedCount).toBe(2);
    expect([...hydrated.dexPriceAgeSecById]).toEqual([
      ["trusted", 60], ["old", 36_000], ["thin", 60], ["crash", 60], ["boundary", 4500],
      ["stale-publication", 60], ["invalid-publication", 60],
    ]);
    expect([...hydrated.dexPriceStaleIds]).toEqual(["old", "boundary", "missing", "stale-publication",
      "invalid-publication", "malformed", "future", "invalid"]);
    expect(hydrated.staleCount).toBe(8);

    const registerSourceFailure = vi.fn();
    const failed = await hydrateDexPrices({
      db: mockD1([{ match: "FROM dex_prices", rows: [], throwError: new Error("dex_prices read failed") }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
    });
    expect(registerSourceFailure).toHaveBeenCalledWith("dex-prices", expect.any(Error));
    expect(failed.staleCount).toBeNull();
    expect(failed.trustedCount).toBe(0);
  });

  it("reports malformed yield warning signals without dropping the valid rows", async () => {
    const registerMalformedPersistedInput = vi.fn();
    const hydrated = await hydrateYieldWarnings({
      db: mockD1([{ match: "FROM yield_data", rows: [
        { stablecoin_id: "usdt-tether", warning_signals: JSON.stringify(["depeg", "supply"]) },
        { stablecoin_id: "usdc-circle", warning_signals: "[1]" },
      ] }]),
      nowSec: RUN_AT, registerSourceFailure: vi.fn(), registerMalformedPersistedInput,
    });
    expect([...hydrated.yieldWarnings]).toEqual([["usdt-tether", ["depeg", "supply"]]]);
    expect(hydrated.rowsRead).toBe(2);
    // The service, not hydration, owns the published degradesRun value.
    expect(registerMalformedPersistedInput).toHaveBeenCalledWith(expect.objectContaining({
      source: "yield_data", context: "yield_data.warning_signals", stablecoinId: "usdc-circle",
      reason: "invalid-shape",
    }));
  });

  it("records a readable but malformed yield-rankings generation as non-degrading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(RUN_AT * 1000);
    const registerMalformedPersistedInput = vi.fn();
    const registerSourceFailure = vi.fn();
    const hydrated = await hydrateYieldRankingsCache({
      db: mockD1([{ match: "pharos:dews:yield-rankings-cache", rows: [], first: {
        updated_at: RUN_AT - 60,
        value: JSON.stringify({ rankings: { not: "an array" } }),
      } }]),
      nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput,
    });
    expect(hydrated.dependencyDiagnostics).toEqual({
      generationId: null, updatedAt: null, ageSeconds: null,
      freshnessBudgetSec: DEWS_YIELD_RANKINGS_RETENTION_BUDGET_SEC, reason: "invalid-shape",
    });
    expect(registerMalformedPersistedInput).toHaveBeenCalledWith({
      source: "yield-rankings", context: "cache.yield-rankings", stablecoinId: "aggregate",
      updatedAt: RUN_AT - 60, reason: "invalid-shape", degradesRun: false,
    });
    expect(registerSourceFailure).not.toHaveBeenCalled();
  });

  it("keeps mint/burn freshness on the 30-day row when the 24-hour window has no events", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600;
    try {
      insertAdmittedMintBurnGauge(sqlite, end, RUN_AT);
      insertBurnHour(sqlite, end - 25 * 3600);
      const registerSourceFailure = vi.fn();
      const hydrated = await hydrateMintBurn({
        db, nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.mintBurnMap.get("usdt-tether")).toMatchObject({
        burn24h: 0, burnBaseline: 700_000 / 30, baselineDays: 30,
      });
      expect(hydrated.mintBurnAgeSecById.get("usdt-tether")).toBe(0);
      expect(registerSourceFailure).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it("flags a stale published mint/burn window as stale evidence and a freshness failure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const end = Math.floor(RUN_AT / 3600) * 3600 - 26 * 3600;
    try {
      insertAdmittedMintBurnGauge(sqlite, end, RUN_AT - 3600);
      insertBurnHour(sqlite, end - 3600);
      const registerSourceFailure = vi.fn();
      const hydrated = await hydrateMintBurn({
        db, nowSec: RUN_AT, registerSourceFailure, registerMalformedPersistedInput: vi.fn(),
      });
      expect(hydrated.mintBurnMap.get("usdt-tether")).toMatchObject({ burn24h: 700_000 });
      expect([...hydrated.mintBurnStaleIds]).toEqual(["usdt-tether"]);
      expect(hydrated).toMatchObject({ freshCount: 0, staleCount: 1, freshnessAgeSec: 26 * 3600 });
      expect(hydrated.mintBurnAgeSecById.get("usdt-tether")).toBe(26 * 3600);
      expect(registerSourceFailure).toHaveBeenCalledTimes(1);
      expect(registerSourceFailure).toHaveBeenCalledWith(
        "mint-burn-hourly-freshness",
        "mint_burn_hourly age 93600s exceeds 86400s",
      );
    } finally {
      sqlite.close();
    }
  });
});

/**
 * One admitted gauge generation whose 24h/30d scan windows are both complete.
 * The payload clock is pinned to the window end so `hydrateMintBurn` reads at one pin.
 */
function insertAdmittedMintBurnGauge(
  sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"],
  end: number,
  cacheUpdatedAt: number,
  stablecoinId = "usdt-tether",
): void {
  const window = { complete: true, unavailableReason: null };
  const value = {
    gauge: { score: null },
    updatedAt: end,
    publication: {
      evaluatedAt: RUN_AT, requiredBaselineSec: 90 * 86400, freshnessBudgetSec: 7200,
      legs: [{ configKey: "synthetic", configFingerprint: "synthetic-v1", stablecoinId, chainId: "ethereum",
        status: "admitted", reason: null, admittedAt: null, baselineFrom: end - 90 * 86400, baselineTo: end,
        coveredSeconds: 90 * 86400, frontierAgeSec: 0 }],
    },
    window: { start: end - 86400, end, semantics: "closed-utc-hours" },
    coins: [{ stablecoinId, symbol: stablecoinId === "usdt-tether" ? "USDT" : "USDC", pressureShiftScore: null, netFlow24hUsd: null,
      coverage: { startBlock: 1, lastSyncedBlock: 2, lagBlocks: 0, historyStartAt: end - 90 * 86400,
        has24hWindow: true, has30dWindow: true, has90dWindow: true, isPartial: false, status: "full",
        windows: { window24h: window, window7d: window, window30d: window, window90d: window } } }],
  };
  sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
    .run(aggregateFlowCacheKey(24), JSON.stringify(value), cacheUpdatedAt);
}

function insertBurnHour(sqlite: ReturnType<typeof createLatestSchemaSqlite>["sqlite"], hour: number, chain = "ethereum", burn = 700000): void {
  sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
    mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
    VALUES ('usdt-tether', ?, ?, 0, 1, 0, 0, 0, ?, ?)`).run(chain, hour, burn, -burn);
}
