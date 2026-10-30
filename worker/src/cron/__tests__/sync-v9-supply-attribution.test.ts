import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256HexFromBytes } from "@shared/lib/sha256";
import * as evmRpc from "../../lib/evm-rpc";
import { laneScreeningAttemptCacheKey } from "../sync-v9-lane-admin-events";
import {
  createSupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createDwellirNativeCapability } from "../../lib/dwellir-native";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  serializeSafetyScoreV9SupplyAttributionSource,
  SOURCE_FIXED_INPUT_MAX_AGE_SEC,
  type SafetyScoreV9SupplyAttributionSource,
} from "../../lib/safety-score-v9/supply-attribution-source";
import {
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
} from "../../lib/safety-score-v9/supply-attribution-generation";
import type { SupplyAttributionAttemptDiagnostic } from "@shared/types/safety-score-v9-supply-attribution";
import type { SafetyScoreV9SupplyAttributionCaptureOptions } from "../../lib/safety-score-v9/supply-attribution-capture";
import type * as SupplyAttributionCaptureModule from "../../lib/safety-score-v9/supply-attribution-capture";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { buildSafetyScoreV9CaptureControl, SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY } from "../../lib/safety-score-v9/capture-control";
import { ECONOMIC_SUPPLY_BODY_CAPS } from "../../lib/safety-score-v9/economic-supply-observer";
import { supplyAttributionCaptureAdmission } from "../../lib/safety-score-v9/supply-attribution-capture";
import { SUPPLY_ATTRIBUTION_CAPTURE_BUDGET } from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import * as economicObserver from "../../lib/safety-score-v9/economic-supply-observer";
import * as xautObserver from "../../lib/safety-score-v9/xaut-supply-observer";
import { TOTAL_SUPPLY_SELECTOR } from "../../lib/evm-selectors";
import type { DeploymentSupplyCensusEvmDependencies } from "../../lib/safety-score-v9/deployment-supply-census-evm";
import {
  deploymentSupplyCensusTargets,
  type DeploymentSupplyCensusRegistryMeta,
} from "../../lib/safety-score-v9/deployment-supply-census";
import {
  createSafetyScoreV9DeploymentSupplyCensusGeneration,
  readSafetyScoreV9DeploymentSupplyCensus,
  writeSafetyScoreV9DeploymentSupplyCensusGeneration,
} from "../../lib/safety-score-v9/deployment-supply-census-store";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
}));

vi.mock(
  "../../lib/safety-score-v9/supply-attribution-capture",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof SupplyAttributionCaptureModule
      >();
    return {
      ...original,
      captureSafetyScoreV9SupplyAttribution: mocks.capture,
    };
  },
);

const { syncSafetyScoreV9SupplyAttribution, deploymentSupplyCensusCohort, deploymentSupplyCensusSelection } =
  await import("../sync-v9-supply-attribution");


function openDb(): { sqlite: DatabaseSync; db: D1Database } {
  return createLatestSchemaSqlite();
}

function xautSourceFixture(): SafetyScoreV9SupplyAttributionSource {
  const clockSec = 1_791_184_659;
  // These cron scenarios exercise XAUT's rejection/cooldown contract, not the
  // live reviewed cohort. New registry plans must not expand this exact input.
  return {
    schemaVersion: 1,
    kind: "safety-score-v9-supply-attribution-source",
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    sourceGeneration: "report-cards:v8:xaut-cron-fixture",
    registryFingerprint: "b".repeat(64),
    clockSec,
    activeAssetIds: ["xaut-tether"],
    aggregateCirculatingById: {
      "xaut-tether": { circulating: { peggedUSD: 2_480_000_000 }, observedAtSec: clockSec },
    },
    chainCirculatingById: { "xaut-tether": {} },
    navPriceById: {},
  };
}

function insertSourceInput(
  sqlite: DatabaseSync,
  fixedInput: SafetyScoreV9SupplyAttributionSource,
): void {
  sqlite
    .prepare(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
    )
    .run(
      SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
      serializeSafetyScoreV9SupplyAttributionSource(fixedInput),
      fixedInput.clockSec,
    );
}

function economicSourceFixture(): SafetyScoreV9SupplyAttributionSource {
  const clockSec = Date.parse("2026-10-29T09:16:00Z") / 1_000;
  const activeAssetIds = ["witry-brix", "xgld-unitas"];
  return {
    ...xautSourceFixture(), clockSec, activeAssetIds, chainCirculatingById: {},
    aggregateCirculatingById: Object.fromEntries(activeAssetIds.map(id =>
      [id, { circulating: { peggedUSD: 1_000_000 }, observedAtSec: clockSec }])),
    navPriceById: Object.fromEntries(activeAssetIds.map(id =>
      [id, { priceUsd: 1, sourceId: "coingecko", confidence: "high" as const, observedAtSec: clockSec }])),
  };
}

describe("syncSafetyScoreV9SupplyAttribution", () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the attribution status and screening journal before a mid-lane host guard deadline", async () => {
    const { sqlite, db } = openDb();
    try {
      const source = censusSourceFixture();
      const nowSec = source.clockSec + 60;
      vi.setSystemTime(nowSec * 1_000);
      insertSourceInput(sqlite, source);
      mocks.capture.mockResolvedValue({
        captureClockSec: nowSec, expectedAssetIds: [], attributionById: {}, journalRecords: [],
      });
      const head = { number: 100_000, timestamp: nowSec - 60, hash: `0x${"a".repeat(64)}` as `0x${string}` };
      vi.spyOn(evmRpc, "fetchEvmBlockHeaderAtTag").mockResolvedValue(head);
      vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockResolvedValue(head);
      vi.spyOn(evmRpc, "usableCcipRpcEndpoints").mockReturnValue([{
        url: "https://rpc.example", operator: "public", maxLogBlockSpan: 10_000,
        keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full",
      }]);
      vi.spyOn(evmRpc, "fetchEvmRpcBatchDetailed").mockImplementation(async (_chain, calls) => {
        vi.setSystemTime(Date.now() + 9_000);
        return {
          results: calls.map(call => call.method === "eth_getCode" ? "0x6000"
            : call.method === "eth_getLogs" ? []
            : { number: call.params[0], timestamp: `0x${(nowSec - 60).toString(16)}`, hash: head.hash }),
          errors: [],
        };
      });
      const deadlineMs = Date.now() + 100_000;
      const lane = "ethereum:0x1111111111111111111111111111111111111111";
      const result = await syncSafetyScoreV9SupplyAttribution(
        db, new Map([["ethereum", { chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "" }]]),
        undefined, { slotStartedAtSec: nowSec, deadlineMs, minimumRemainingMs: 60_000 }, undefined,
        { metaById: new Map() },
        { descriptors: [{
          subjectDeploymentKey: lane, lookbackBlocks: 100_000,
          emitters: [{ address: "0x1111111111111111111111111111111111111111",
            expectedRuntimeCodeSha256: sha256HexFromBytes(new Uint8Array([0x60, 0])), families: ["Paused"] }],
        }] },
      );
      // This suite uses synchronous SQLite and RPC clock advances, so assert the
      // strict guard boundary directly rather than replacing the window wrapper.
      expect(Date.now()).toBeLessThan(deadlineMs - 15_000);
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.metadata!)).toMatchObject({
        laneScreening: { status: "published", deadlineExhausted: true, attempted: 1, certificatesWritten: 0 },
      });
      const attempt = sqlite.prepare("SELECT value FROM cache WHERE key=?")
        .get(laneScreeningAttemptCacheKey(lane)) as { value: string };
      expect(JSON.parse(attempt.value)).toMatchObject({ outcome: "deferred", reason: "deadline" });
    } finally { vi.restoreAllMocks(); sqlite.close(); }
  });

  it.each([
    ["2026-10-29T09:38:00Z", []],
    ["2026-10-29T09:53:00Z", ["witry-brix", "xgld-unitas"]],
    ["2026-10-29T10:08:00Z", ["witry-brix", "xgld-unitas"]],
  ])("admits input references with the child capture margin at %s", (time, deferredAssetIds) => {
    expect(supplyAttributionCaptureAdmission(economicSourceFixture(), Date.parse(time as string) / 1_000))
      .toMatchObject({ deferredAssetIds, captureMarginSec: SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs / 1_000,
        referencePriceMaxAgeSec: V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.referencePriceMaxAgeSec });
  });

  it("uses the actual reference clock and admits the exact reference-age boundary", () => {
    const source = economicSourceFixture();
    const marginSec = SUPPLY_ATTRIBUTION_CAPTURE_BUDGET.assetTimeoutMs / 1_000;
    const maxAgeSec = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.referencePriceMaxAgeSec;
    const boundary = source.clockSec + maxAgeSec - marginSec;
    expect(supplyAttributionCaptureAdmission(source, boundary).deferredAssetIds).toEqual([]);
    expect(supplyAttributionCaptureAdmission(source, boundary + 1).deferredAssetIds).toEqual(source.activeAssetIds);
    source.navPriceById["witry-brix"].observedAtSec -= 1;
    expect(supplyAttributionCaptureAdmission(source, boundary).deferredAssetIds).toEqual(["witry-brix"]);
  });

  it.each(["09:09:00", "09:10:00", "09:11:00"])("admits a pre-build reference from %s at the :38 asset start", time => {
    const source = economicSourceFixture();
    for (const price of Object.values(source.navPriceById)) price.observedAtSec = Date.parse(`2026-10-29T${time}Z`) / 1_000;
    const start = Date.parse("2026-10-29T09:38:00Z") / 1_000;
    expect(supplyAttributionCaptureAdmission(source, start, start * 1_000 + 30_000).deferredAssetIds).toEqual([]);
  });

  it("keeps already-stale upstream references blocking across repeated runs without RPC", async () => {
    const { sqlite, db } = openDb();
    const observer = vi.spyOn(economicObserver, "observeReviewedEconomicDeploymentPartitionAttempt");
    try {
      const source = economicSourceFixture();
      for (const price of Object.values(source.navPriceById)) price.observedAtSec = source.clockSec - 30 * 60;
      insertSourceInput(sqlite, source);
      const actual = await vi.importActual<typeof SupplyAttributionCaptureModule>("../../lib/safety-score-v9/supply-attribution-capture");
      mocks.capture.mockImplementation(actual.captureSafetyScoreV9SupplyAttribution);
      for (const time of ["09:38:00", "09:53:00", "10:08:00"]) {
        vi.setSystemTime(Date.parse(`2026-10-29T${time}Z`));
        const result = await syncSafetyScoreV9SupplyAttribution(db, new Map());
        expect(result.status, result.metadata).toBe("degraded");
        expect(JSON.parse(result.metadata ?? "{}").blockingRejectedAssetIds).toEqual(source.activeAssetIds);
      }
      expect(observer).not.toHaveBeenCalled();
    } finally { observer.mockRestore(); sqlite.close(); }
  });

  it.each(["2026-10-29T09:53:00Z", "2026-10-29T10:08:00Z"])("skips stale-reference-only runs before capture at %s and preserves the generation", async time => {
    const { sqlite, db } = openDb();
    try {
      const source = economicSourceFixture();
      insertSourceInput(sqlite, source);
      // Admission must not overwrite even a malformed prior cache while idle.
      const retained = "retained-generation-bytes";
      sqlite.prepare("INSERT INTO cache(key,value,updated_at) VALUES (?,?,?)")
        .run(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY, retained, source.clockSec);
      vi.setSystemTime(Date.parse(time));
      const result = await syncSafetyScoreV9SupplyAttribution(db, new Map());
      expect(result.status).toBe("skipped_neutral");
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        stage: "capture-admission", reason: "supply-attribution-input-stale-for-reference",
        deferredAssetIds: source.activeAssetIds, sourceClockSec: source.clockSec,
      });
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT value FROM cache WHERE key=?")
        .get(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY)?.value).toBe(retained);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_supply_attribution_journal").get())
        .toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("captures co-tenants while deferring stale economic inputs before their observers run", async () => {
    const { sqlite, db } = openDb();
    const economicSpy = vi.spyOn(economicObserver, "observeReviewedEconomicDeploymentPartitionAttempt");
    const xautSpy = vi.spyOn(xautObserver, "observeXautRepresentationGroupSupplyAttributionAttempt")
      .mockResolvedValue({ status: "rejected", rejectionCode: "transparency-stale", failedRouteId: null,
        rejectedSourceObservedAtSec: economicSourceFixture().clockSec - 3 * 24 * 60 * 60 });
    try {
      const source = economicSourceFixture();
      source.activeAssetIds.push("xaut-tether");
      source.aggregateCirculatingById["xaut-tether"] = xautSourceFixture().aggregateCirculatingById["xaut-tether"];
      insertSourceInput(sqlite, source);
      vi.setSystemTime(Date.parse("2026-10-29T09:53:00Z"));
      const actual = await vi.importActual<typeof SupplyAttributionCaptureModule>("../../lib/safety-score-v9/supply-attribution-capture");
      mocks.capture.mockImplementation(actual.captureSafetyScoreV9SupplyAttribution);
      const result = await syncSafetyScoreV9SupplyAttribution(db, new Map([["ethereum", {
        chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "",
      }]]));
      expect(result.status, result.metadata).toBe("ok");
      expect(economicSpy).not.toHaveBeenCalled();
      expect(xautSpy).toHaveBeenCalledOnce();
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        blockingRejectedAssetIds: [],
        quality: { reason: "supply-attribution-input-stale-for-reference" },
        captureAdmission: { deferredAssetIds: ["witry-brix", "xgld-unitas"] },
      });
      const cached = sqlite.prepare("SELECT value FROM cache WHERE key=?")
        .get(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY) as { value: string };
      const generation = parseSafetyScoreV9SupplyAttributionGeneration(cached.value);
      expect(generation.outcomesById["witry-brix"]).toMatchObject({
        status: "rejected", rejectionCode: "observation-stale",
        failedRouteId: "supply-attribution-input-stale-for-reference",
      });
    } finally { economicSpy.mockRestore(); xautSpy.mockRestore(); sqlite.close(); }
  });

  it.each([["09:09:00", 2], ["09:08:30", 0]] as const)("rechecks a %s reference after earlier co-tenant work", async (referenceTime, calls) => {
    const { sqlite, db } = openDb();
    const economicSpy = vi.spyOn(economicObserver, "observeReviewedEconomicDeploymentPartitionAttempt")
      .mockResolvedValue({ status: "rejected", rejectionCode: "deployment-state-unavailable", failedRouteId: null });
    const xautSpy = vi.spyOn(xautObserver, "observeXautRepresentationGroupSupplyAttributionAttempt").mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return { status: "rejected", rejectionCode: "transparency-stale", failedRouteId: null, rejectedSourceObservedAtSec: 0 };
    });
    try {
      const source = economicSourceFixture();
      for (const price of Object.values(source.navPriceById)) price.observedAtSec = Date.parse(`2026-10-29T${referenceTime}Z`) / 1_000;
      source.activeAssetIds.push("xaut-tether");
      source.aggregateCirculatingById["xaut-tether"] = xautSourceFixture().aggregateCirculatingById["xaut-tether"];
      insertSourceInput(sqlite, source);
      vi.setSystemTime(Date.parse("2026-10-29T09:38:00Z"));
      expect(supplyAttributionCaptureAdmission(source, Date.now() / 1_000).deferredAssetIds).toEqual([]);
      const actual = await vi.importActual<typeof SupplyAttributionCaptureModule>("../../lib/safety-score-v9/supply-attribution-capture");
      mocks.capture.mockImplementation(actual.captureSafetyScoreV9SupplyAttribution);
      const result = await syncSafetyScoreV9SupplyAttribution(db, new Map([["ethereum", {
        chainId: "ethereum", chainName: "Ethereum", type: "evm", endpoints: [], explorerUrl: "",
      }]]));
      expect(economicSpy).toHaveBeenCalledTimes(calls);
      if (calls === 0) {
        expect(JSON.parse(result.metadata ?? "{}").captureAdmission.assets["witry-brix"])
          .toMatchObject({ admissionClockSec: Date.parse("2026-10-29T09:38:20Z") / 1_000, captureMarginSec: 30 });
      }
    } finally { economicSpy.mockRestore(); xautSpy.mockRestore(); sqlite.close(); }
  });

  it("publishes one exact diagnostic rejected generation as healthy and retries only after the producer cooldown", async () => {
    const { sqlite, db } = openDb();
    try {
      const fixedInput = xautSourceFixture();
      const nowSec = fixedInput.clockSec + 15 * 60;
      vi.setSystemTime(nowSec * 1_000);
      insertSourceInput(sqlite, fixedInput);
      const journal = createSupplyAttributionJournalV1({
        schemaVersion: 1,
        lane: "supply-attribution",
        assetId: "xaut-tether",
        attemptId: "supply-attribution:isolated-fixture",
        sourceId:
          "xaut.canonical-lock-mint-group-partition.v2",
        sourceOriginClass: "issuer-disclosure-plus-onchain",
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        sourceGeneration: fixedInput.sourceGeneration,
        registryFingerprint: fixedInput.registryFingerprint,
        routeInventoryDigest: null,
        attemptCode: "supply-attribution.collector.attempted",
        admissionCode:
          "supply-attribution.admission.rejected-stale",
        fallbackCode:
          "supply-attribution.fallback.aggregate-only",
        rejectionCode: "transparency-stale",
        attemptedAtSec: nowSec - 1,
        completedAtSec: nowSec,
        scoringClockSec: nowSec,
        sourceObservedAtSec: fixedInput.clockSec - 1,
        failedRouteId: null,
        contentSha256: null,
      });
      mocks.capture.mockResolvedValue({
        captureClockSec: nowSec,
        expectedAssetIds: ["xaut-tether"],
        attributionById: {},
        journalRecords: [journal],
        performanceById: { "xaut-tether": { elapsedMs: 123, evmRpcRequests: 2 } },
      });

      const dwellirNative = createDwellirNativeCapability("native-test-key-placeholder");
      const first = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
        undefined, undefined, dwellirNative,
      );
      expect(first.status).toBe("ok");
      expect(first.productivity?.reason).toBe(
        "supply-attribution-generation-published-with-diagnostic-rejections",
      );
      expect(JSON.parse(first.metadata ?? "{}")).toMatchObject({
        rejectedAssetIds: ["xaut-tether"],
        diagnosticRejectedAssetIds: ["xaut-tether"],
        diagnosticRejectedCount: 1,
        blockingRejectedAssetIds: [],
        blockingRejectedCount: 0,
        latencySummary: { assets: { "xaut-tether": { elapsedMs: 123, evmRpcRequests: 2 } } },
      });
      expect(mocks.capture).toHaveBeenCalledTimes(1);
      expect(mocks.capture.mock.calls[0]?.[3]).toMatchObject({ dwellirNative });
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM safety_score_v9_supply_attribution_journal",
          )
          .get(),
      ).toEqual({ count: 1 });
      const cached = sqlite
        .prepare("SELECT value FROM cache WHERE key = ?")
        .get(
          SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
        ) as { value: string };
      const generation =
        parseSafetyScoreV9SupplyAttributionGeneration(cached.value);
      expect(generation).toMatchObject({
        expectedAssetIds: ["xaut-tether"],
        observedAssetIds: ["xaut-tether"],
        acceptedAssetIds: [],
        rejectedAssetIds: ["xaut-tether"],
      });

      const second = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
      );
      expect(second.status).toBe("skipped_neutral");
      expect(mocks.capture).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it.each(["matching", "different-slot", "newer-source", "thrown", "failed-write", "cooldown"] as const)("fences attribution settlement for %s", async kind => {
    const { db, sqlite } = openDb();
    try {
      const source = { ...xautSourceFixture(), activeAssetIds: [], clockSec: Date.parse("2026-10-07T20:17:00Z") / 1_000 };
      insertSourceInput(sqlite, source);
      const control = buildSafetyScoreV9CaptureControl({
        safetyScoreIdentity: buildSafetyScoreV9InputIdentity({
          methodologyVersion: "10.05", baseInputGenerationId: source.baseInputGenerationId, publicationGenerationId: source.sourceGeneration,
        }),
        baseInputGenerationId: source.baseInputGenerationId, sourceGeneration: source.sourceGeneration,
        clockSec: source.clockSec, registryFingerprint: source.registryFingerprint, workerVersion: "worker", workerUploadedAtSec: source.clockSec,
      }, source.clockSec);
      sqlite.prepare("INSERT INTO cache(key,value,updated_at) VALUES (?,?,?)")
        .run(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY, JSON.stringify(control), source.clockSec);
      const due = control.attribution.dueSlotStartedAtSec;
      vi.setSystemTime(due * 1_000);
      const window = { slotStartedAtSec: due + (kind === "different-slot" ? 900 : 0), deadlineMs: (due + 180) * 1_000, minimumRemainingMs: 60_000 };
      mocks.capture.mockImplementation(async () => {
        if (kind === "newer-source") {
          const next = { ...control, capture: { ...control.capture, clockSec: source.clockSec + 1 } };
          sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(JSON.stringify(next), SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY);
        }
        if (kind === "thrown") throw new Error("observer exploded");
        return { captureClockSec: due, expectedAssetIds: [], attributionById: {}, journalRecords: [] };
      });
      if (kind === "failed-write") sqlite.exec(`CREATE TRIGGER failed_generation BEFORE INSERT ON cache
        WHEN NEW.key='${SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY}' BEGIN SELECT RAISE(ABORT,'generation write failed'); END`);
      if (kind === "thrown" || kind === "failed-write") {
        await expect(syncSafetyScoreV9SupplyAttribution(db, new Map(), undefined, window)).rejects.toThrow();
      } else {
        await syncSafetyScoreV9SupplyAttribution(db, new Map(), undefined, window);
        if (kind === "cooldown") {
          control.attribution.status = "pending"; control.attribution.outcome = null;
          sqlite.prepare("UPDATE cache SET value=? WHERE key=?").run(JSON.stringify(control), SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY);
          expect((await syncSafetyScoreV9SupplyAttribution(db, new Map(), undefined, window)).status).toBe("skipped_neutral");
          expect(mocks.capture).toHaveBeenCalledOnce();
        }
      }
      const stored = JSON.parse(String(sqlite.prepare("SELECT value FROM cache WHERE key=?").get(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY)!.value));
      expect(stored.attribution.status).toBe(kind === "different-slot" || kind === "newer-source" ? "pending" : "settled");
      if (kind === "thrown" || kind === "failed-write") expect(stored.attribution.outcome).toBe("error");
    } finally { sqlite.close(); }
  });

  it.each([
    { name: "authenticated persisted bootstrap advancement", persisted: true, advanced: true, hard: false, status: "ok" },
    { name: "timestamp-only rewrite", persisted: true, advanced: false, hard: false, status: "degraded" },
    { name: "unpersisted cursor movement", persisted: false, advanced: true, hard: false, status: "degraded" },
    { name: "no progress", persisted: false, advanced: false, hard: false, status: "degraded" },
    { name: "hard failure despite persisted advancement", persisted: true, advanced: true, hard: true, status: "degraded" },
  ])("classifies $name without admitting rejected packets", async scenario => {
    const { sqlite, db } = openDb();
    try {
      const assetId = "srusd-reservoir";
      const fixedInput: SafetyScoreV9SupplyAttributionSource = {
        ...xautSourceFixture(),
        activeAssetIds: [assetId],
        aggregateCirculatingById: {
          [assetId]: { circulating: { peggedUSD: 1_000_000 }, observedAtSec: xautSourceFixture().clockSec },
        },
        chainCirculatingById: {},
      };
      const nowSec = fixedInput.clockSec + 15 * 60;
      vi.setSystemTime(nowSec * 1_000);
      insertSourceInput(sqlite, fixedInput);
      const diagnostic: SupplyAttributionAttemptDiagnostic = {
        observer: "layerzero-oft", sourceId: "srusd-ethereum-oft-escrow",
        laneId: "ethereum:berachain", chainId: "ethereum", providerOrigin: "https://rpc.example",
        method: "eth_getLogs", phase: "bootstrap-prefix",
        beforeCursor: "100", afterCursor: scenario.advanced ? "101" : "100", targetCursor: "200",
        pinObservedAtSec: nowSec, finalizedLagBlocks: 0,
        persisted: scenario.persisted, authenticatedCursorAdvanced: scenario.advanced,
        incompleteBootstrap: true, hardEvidenceFailure: false, failurePredicate: "history-incomplete",
      };
      const diagnostics = [
        diagnostic,
        ...(scenario.hard ? [{
          ...diagnostic, phase: "reconciliation", persisted: false, authenticatedCursorAdvanced: false,
          incompleteBootstrap: false, hardEvidenceFailure: true, failurePredicate: "packet-reconciliation-failed",
        }] : []),
      ];
      const journal = createSupplyAttributionJournalV1({
        schemaVersion: 1, lane: "supply-attribution", assetId,
        attemptId: `supply-attribution:bootstrap-${scenario.persisted}-${scenario.advanced}-${scenario.hard}`,
        sourceId: "reviewed.economic-deployment-partition.v1",
        sourceOriginClass: "issuer-disclosure-plus-onchain",
        baseInputGenerationId: fixedInput.baseInputGenerationId, sourceGeneration: fixedInput.sourceGeneration,
        registryFingerprint: fixedInput.registryFingerprint, routeInventoryDigest: null,
        attemptCode: "supply-attribution.collector.attempted",
        admissionCode: scenario.hard ? "supply-attribution.admission.rejected-reconciliation" : "supply-attribution.admission.rejected-upstream",
        fallbackCode: "supply-attribution.fallback.aggregate-only",
        rejectionCode: scenario.hard ? "packet-reconciliation-failed" : "deployment-state-unavailable",
        attemptedAtSec: nowSec - 1, completedAtSec: nowSec, scoringClockSec: nowSec,
        sourceObservedAtSec: null, failedRouteId: "in-flight:srusd-ethereum-oft-escrow:history-incomplete",
        contentSha256: null,
      });
      mocks.capture.mockImplementation(async (
        _input: unknown, _rpcs: unknown, _signal: unknown, options: SafetyScoreV9SupplyAttributionCaptureOptions,
      ) => {
        options.onBodyRead?.({ intakeBytes: 64, declaredBytes: 64, outcome: "accepted" });
        options.onBodyRead?.({ intakeBytes: 128, declaredBytes: null, outcome: scenario.hard ? "rejected" : "accepted" });
        return {
          captureClockSec: nowSec, expectedAssetIds: [assetId], attributionById: {},
          journalRecords: [journal], diagnosticsById: { [assetId]: diagnostics },
        };
      });

      const result = await syncSafetyScoreV9SupplyAttribution(db, new Map());
      expect(result.status).toBe(scenario.status);
      expect(result.itemCount).toBe(0);
      const metadata = JSON.parse(result.metadata ?? "{}");
      if (scenario.status === "ok") {
        expect(metadata.quality).toMatchObject({ reason: "supply-attribution-bootstrap-in-progress" });
      }
      expect(metadata).toMatchObject({
        rejectedAssetIds: [assetId],
        blockingRejectedAssetIds: scenario.status === "ok" ? [] : [assetId],
        resourcePressure: {
          bodyCapBytes: ECONOMIC_SUPPLY_BODY_CAPS.xrplGatewayBalances,
          intakeBytes: 192, rejectedBodies: scenario.hard ? 1 : 0,
        },
      });
      const cached = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY) as { value: string };
      const generation = parseSafetyScoreV9SupplyAttributionGeneration(cached.value);
      expect(generation.acceptedAssetIds).toEqual([]);
      expect(generation.attributionById).toEqual({});
      expect(generation.outcomesById[assetId]).toMatchObject({ status: "rejected", diagnostics });
    } finally { sqlite.close(); }
  });

  it("keeps blocking rejected generations degraded", async () => {
    const { sqlite, db } = openDb();
    try {
      const fixedInput = xautSourceFixture();
      const nowSec = fixedInput.clockSec + 15 * 60;
      vi.setSystemTime(nowSec * 1_000);
      insertSourceInput(sqlite, fixedInput);
      const journal = createSupplyAttributionJournalV1({
        schemaVersion: 1,
        lane: "supply-attribution",
        assetId: "xaut-tether",
        attemptId: "supply-attribution:blocking-fixture",
        sourceId:
          "xaut.canonical-lock-mint-group-partition.v2",
        sourceOriginClass: "issuer-disclosure-plus-onchain",
        baseInputGenerationId: fixedInput.baseInputGenerationId,
        sourceGeneration: fixedInput.sourceGeneration,
        registryFingerprint: fixedInput.registryFingerprint,
        routeInventoryDigest: null,
        attemptCode: "supply-attribution.collector.attempted",
        admissionCode:
          "supply-attribution.admission.rejected-upstream",
        fallbackCode:
          "supply-attribution.fallback.aggregate-only",
        rejectionCode: "transparency-source-unavailable",
        attemptedAtSec: nowSec - 1,
        completedAtSec: nowSec,
        scoringClockSec: nowSec,
        sourceObservedAtSec: null,
        failedRouteId: null,
        contentSha256: null,
      });
      mocks.capture.mockResolvedValue({
        captureClockSec: nowSec,
        expectedAssetIds: ["xaut-tether"],
        attributionById: {},
        journalRecords: [journal],
        failureReasonById: { "xaut-tether": "capture-window-exhausted" },
      });

      const result = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
      );

      expect(result.status).toBe("degraded");
      expect(result.productivity?.reason).toBe(
        "supply-attribution-generation-published-with-blocking-rejections",
      );
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        rejectedAssetIds: ["xaut-tether"],
        diagnosticRejectedAssetIds: [],
        diagnosticRejectedCount: 0,
        blockingRejectedAssetIds: ["xaut-tether"],
        blockingRejectedCount: 1,
      });
      const cached = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY) as { value: string };
      const priorGeneration = parseSafetyScoreV9SupplyAttributionGeneration(cached.value);
      expect(priorGeneration.outcomesById["xaut-tether"]).toMatchObject({
        status: "rejected", captureFailureReason: "capture-window-exhausted",
      });
      vi.setSystemTime((nowSec + 14 * 60) * 1_000);
      await syncSafetyScoreV9SupplyAttribution(db, new Map());
      expect(mocks.capture).toHaveBeenCalledTimes(2);
      expect(mocks.capture).toHaveBeenLastCalledWith(
        fixedInput, expect.any(Map), undefined,
        expect.objectContaining({ priorGeneration }),
      );
    } finally {
      sqlite.close();
    }
  });

  it("fails closed before capture when the source fixed input is absent", async () => {
    const { sqlite, db } = openDb();
    try {
      const result = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
      );
      expect(result).toMatchObject({
        status: "degraded",
        itemCount: 0,
        productivity: {
          productive: false,
          reason: "source-fixed-input-missing",
        },
      });
      expect(mocks.capture).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

const CENSUS_CLOCK_SEC = Date.parse("2026-10-29T09:16:00Z") / 1_000;
const CENSUS_TOKEN = `0x${"d".repeat(40)}`;

function censusRoute(chain: string, address: string, reviewed = true) {
  return {
    id: `${chain}:${address}`,
    destinationChain: chain,
    contractAddress: address,
    protocol: "fixture-bridge",
    issuanceModel: reviewed ? "bridge-representation" : "unknown",
    routeClass: reviewed ? "canonical" : "unknown",
    riskTier: reviewed ? "canonical-rollup-bridge" : "opaque-or-unknown",
    semantics: reviewed ? "lock-mint" : "unknown",
    scope: reviewed ? "canonical" : "unknown",
    reviewDisposition: reviewed ? "reviewed" : "unresolved",
    reviewNote: "Fixture route review",
    observedAt: "2026-10-29",
    sources: [{ label: "Fixture", url: "https://example.com" }],
  } as const;
}

function censusMeta(
  assetId: string,
  routes: readonly { chain: string; address: string; reviewed?: boolean }[],
): DeploymentSupplyCensusRegistryMeta {
  return {
    id: assetId,
    contracts: routes
      .filter(route => route.chain !== "xrpl")
      .map(route => ({ chain: route.chain, address: route.address, decimals: 6 })),
    bridgeRouteRisk: {
      tier: "canonical-rollup-bridge",
      summary: "Fixture bridge route review.",
      reviewedAt: "2026-10-29",
      reviewer: "fixture",
      confidence: "verified",
      routes: routes.map(route => censusRoute(route.chain, route.address, route.reviewed)),
    },
  } as unknown as DeploymentSupplyCensusRegistryMeta;
}

function censusSourceFixture(): SafetyScoreV9SupplyAttributionSource {
  const censusProjection: NonNullable<SafetyScoreV9SupplyAttributionSource["censusProjection"]> = {
    activeAssetIds: ["shadow-fixture"],
    aggregateCirculatingById: {
      "shadow-fixture": { circulating: { peggedUSD: 1_000_000 }, observedAtSec: CENSUS_CLOCK_SEC },
    },
    // No provider chain row for the fixture: its reviewed deployment has no
    // reviewed share, which is exactly the open gap the census cohort selects.
    chainCirculatingById: {},
    navPriceById: {
      "shadow-fixture": {
        priceUsd: 1, sourceId: "fixture-price", confidence: "high",
        observedAtSec: CENSUS_CLOCK_SEC - 60,
      },
    },
    pegReferenceById: {},
  };
  return {
    ...xautSourceFixture(),
    clockSec: CENSUS_CLOCK_SEC,
    // The census population is independent of the attribution allowlist.
    activeAssetIds: [],
    aggregateCirculatingById: {},
    chainCirculatingById: {},
    navPriceById: {},
    censusProjection,
  };
}

function word(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function censusEvmDependencies(options: { pin?: boolean } = {}) {
  const multicall = vi.fn(async (
    _chain: string | undefined,
    calls: readonly { label: string; target: string; callData: string }[],
  ) => calls.map(call => ({
    label: call.label,
    success: true,
    returnData: word(call.callData === TOTAL_SUPPLY_SELECTOR ? 1_000_000n : 6n),
  })));
  const dependencies = {
    resolveClosestBlockAtOrBeforeTimestamp: async () => options.pin === false ? null : 100,
    // A missing pin requires both the bracket search and finalized fallback
    // to be unavailable; a successful finalized read is valid evidence.
    fetchEvmBlockHeader: async () => options.pin === false ? null : ({
      number: 100,
      hash: `0x${"ab".repeat(32)}` as `0x${string}`,
      timestamp: CENSUS_CLOCK_SEC - 60,
    }),
    fetchEvmCodeStatusAtBlock: async () => ({ status: "available" as const, code: "0x6000" as `0x${string}` }),
    fetchEvmMulticall3Aggregate3AtBlock: multicall,
    sha256Hex: async () => "f".repeat(64),
  } as unknown as Partial<DeploymentSupplyCensusEvmDependencies>;
  return { dependencies, multicall };
}

const CENSUS_CHAIN_RPCS = new Map([["ethereum", {
  chainId: "ethereum", chainName: "Ethereum", type: "evm" as const, endpoints: [], explorerUrl: "",
}]]);

describe("V9 supply attribution shadow census lane", () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("cohorts only the open gap population inside the 96-asset and 256-deployment caps", () => {
    const targets = (rows: readonly [string, number, number][]) =>
      rows.map(([assetId, gapRoutes, reviewedRoutes]) => ({
        assetId, gapRoutes, reviewedRoutes, rosterRoutes: reviewedRoutes,
      }));

    // An asset with no open gap never consumes a slot.
    expect(deploymentSupplyCensusCohort({
      targets: targets([["resolved", 0, 4], ["gap-small", 1, 2]]),
    })).toEqual(["gap-small"]);

    // Selection ranks by open-gap count (then smaller roster, then code units);
    // the returned cohort is the stable alphabetical set.
    expect(deploymentSupplyCensusCohort({
      targets: targets([
        ["limited", 2, 1], ["wide", 5, 3], ["tie-b", 2, 5], ["tie-a", 2, 5],
      ]),
    })).toEqual(["limited", "tie-a", "tie-b", "wide"]);
    expect(deploymentSupplyCensusCohort({
      targets: targets([["limited", 2, 1], ["wide", 5, 3]]),
      maxAssets: 1,
    })).toEqual(["wide"]);

    // Caps: 85 x 3 = 255 deployments, a 96th single-deployment asset, and a
    // target that cannot fit the remaining deployment budget is skipped.
    const many = Array.from({ length: 120 }, (_, index) => ({
      assetId: `asset-${String(index).padStart(3, "0")}`,
      gapRoutes: 1, reviewedRoutes: 3, rosterRoutes: 3,
    }));
    expect(deploymentSupplyCensusCohort({ targets: many })).toHaveLength(85);
    expect(deploymentSupplyCensusCohort({
      targets: many.map(target => ({ ...target, reviewedRoutes: 1, rosterRoutes: 1 })),
    })).toHaveLength(96);
    expect(deploymentSupplyCensusCohort({
      targets: [
        { assetId: "too-large", gapRoutes: 9, reviewedRoutes: 257, rosterRoutes: 257 },
        { assetId: "fits", gapRoutes: 1, reviewedRoutes: 1, rosterRoutes: 1 },
      ],
    })).toEqual(["fits"]);
  });

  it("fits the cohort inside the run request budget and names what it leaves open", () => {
    const target = (assetId: string, gapRoutes: number, evmRoutes: number, evmChains: string[]) =>
      ({ assetId, gapRoutes, reviewedRoutes: evmRoutes, rosterRoutes: evmRoutes, evmRoutes, evmChains });
    const targets = [
      target("wide", 5, 4, ["ethereum"]),
      target("same-chain", 4, 2, ["ethereum"]),
      target("new-chain", 3, 2, ["base"]),
      target("no-gap", 0, 2, ["ethereum"]),
    ];

    // wide 4+1 code/supply +32 pin +2 slack = 39; same-chain 2+1+0+2 = 5;
    // new-chain 2+1+32+2 = 37; total 81 inside a 100-request run budget.
    const fitted = deploymentSupplyCensusSelection({ targets, maxRequests: 100 });
    expect(fitted.assetIds).toEqual(["new-chain", "same-chain", "wide"]);
    expect(fitted.estimatedRequests).toBe(81);
    expect(fitted.skippedAssetIds).toEqual([]);

    // A budget that cannot fit the new chain leaves the asset every gap route
    // open instead of half-reading it after the gate starts rejecting.
    const tight = deploymentSupplyCensusSelection({ targets, maxRequests: 60 });
    expect(tight.assetIds).toEqual(["same-chain", "wide"]);
    expect(tight.estimatedRequests).toBe(44);
    expect(tight.skippedAssetIds).toEqual(["new-chain"]);

    // Deterministic: insertion order never changes the fit.
    expect(deploymentSupplyCensusSelection({ targets: [...targets].reverse(), maxRequests: 60 }))
      .toEqual(tight);
  });

  it("derives targets from open null-share deployments, never from roster size", () => {
    const metaById = new Map<string, DeploymentSupplyCensusRegistryMeta>([
      ["single", censusMeta("single", [{ chain: "ethereum", address: `0x${"1".repeat(40)}` }])],
      ["ambiguous", censusMeta("ambiguous", [
        { chain: "ethereum", address: `0x${"2".repeat(40)}` },
        { chain: "ethereum", address: `0x${"3".repeat(40)}` },
      ])],
      ["no-row", censusMeta("no-row", [{ chain: "base", address: `0x${"4".repeat(40)}` }])],
      ["unreviewed", censusMeta("unreviewed", [{
        chain: "ethereum", address: `0x${"5".repeat(40)}`, reviewed: false,
      }])],
      ["over-cap", censusMeta("over-cap", Array.from({ length: 65 }, (_, index) => ({
        chain: "ethereum", address: `0x${(index + 256).toString(16).padStart(40, "0")}`,
      })))],
    ]);
    const chainCirculatingById = {
      single: { ethereum: { current: 1_000_000 } },
      ambiguous: { ethereum: { current: 1_000_000 } },
    } as const;
    const targets = deploymentSupplyCensusTargets({
      assetIds: [...metaById.keys()],
      metaById,
      chainCirculatingById,
    });
    // `unreviewed` (a partial roster rejects the asset) and `over-cap` (the
    // 65th deployment can never admit) are not targets at all.
    expect(targets).toEqual([
      { assetId: "single", gapRoutes: 0, reviewedRoutes: 1, rosterRoutes: 1,
        evmRoutes: 1, evmChains: ["ethereum"] },
      { assetId: "ambiguous", gapRoutes: 2, reviewedRoutes: 2, rosterRoutes: 2,
        evmRoutes: 2, evmChains: ["ethereum"] },
      { assetId: "no-row", gapRoutes: 1, reviewedRoutes: 1, rosterRoutes: 1,
        evmRoutes: 1, evmChains: ["base"] },
    ]);

    // A reviewed economic deployment partition already resolves every share.
    expect(deploymentSupplyCensusTargets({
      assetIds: ["ambiguous", "no-row"],
      metaById,
      chainCirculatingById,
      supplyAttributionById: {
        ambiguous: { model: "reviewed-economic-deployment-partition-v1" },
      },
    }).map(target => target.gapRoutes)).toEqual([0, 1]);
  });

  it("persists one shadow generation after capture settles and journals every outcome", async () => {
    const { sqlite, db } = openDb();
    try {
      const source = censusSourceFixture();
      const nowSec = source.clockSec + 15 * 60;
      insertSourceInput(sqlite, source);
      vi.setSystemTime(nowSec * 1_000);
      const { dependencies, multicall } = censusEvmDependencies();
      mocks.capture.mockImplementation(async () => {
        // Serial phases: the census lane must not open a connection while the
        // attribution capture is still running (peak stays 3/6, not 6/6).
        expect(multicall).not.toHaveBeenCalled();
        return { captureClockSec: nowSec, expectedAssetIds: [], attributionById: {}, journalRecords: [] };
      });
      const metaById = new Map([["shadow-fixture",
        censusMeta("shadow-fixture", [{ chain: "ethereum", address: CENSUS_TOKEN }])]]);
      const window = {
        slotStartedAtSec: nowSec,
        deadlineMs: (nowSec + 180) * 1_000,
        minimumRemainingMs: 60_000,
      };

      const result = await syncSafetyScoreV9SupplyAttribution(
        db, CENSUS_CHAIN_RPCS, undefined, window, undefined,
        { metaById, dependencies: { evm: dependencies } },
      );
      expect(result.status).toBe("ok");
      const outcome = JSON.parse(result.metadata ?? "{}").deploymentSupplyCensus;
      expect(outcome).toMatchObject({
        status: "published",
        reason: null,
        written: true,
        skippedBecauseNewer: false,
        cohortAssetIds: ["shadow-fixture"],
        measuredAssetIds: ["shadow-fixture"],
        rejectedByAssetId: {},
        excluded: [],
      });
      expect(multicall).toHaveBeenCalled();
      const stored = await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: nowSec });
      expect(stored).toMatchObject({
        state: "ok",
        generationId: outcome.generationId,
        capturedAtSec: nowSec,
      });
      const packet = stored.byId["shadow-fixture"]!;
      expect(packet.observedAtSec).toBe(nowSec);
      expect(packet.conservation).toMatchObject({ rosterComplete: true, conserved: true });
      expect(packet.deployments).toHaveLength(1);
      expect(packet.deployments[0]).toMatchObject({
        routeId: `ethereum:${CENSUS_TOKEN}`,
        evidenceKind: "upper-bound",
      });
      expect(packet.deployments[0]!.shareUpper).toBeLessThan(0.01);
      // DRY-CENSUS F1: the census built in this run is carried into the
      // attribution generation that same run publishes, bound to this input.
      // node:sqlite rows are untyped; the cache insert above fixes the shape.
      const generationRow = sqlite.prepare("SELECT value FROM cache WHERE key=?")
        .get(SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY) as { value: string } | undefined;
      const published = parseSafetyScoreV9SupplyAttributionGeneration(generationRow?.value);
      expect(published.deploymentSupplyCensusById).toEqual({ "shadow-fixture": packet });
      expect(published.deploymentSupplyCensusBinding).toEqual({
        generationId: outcome.generationId,
        registryFingerprint: source.registryFingerprint,
        sourceBaseInputGenerationId: source.baseInputGenerationId,
      });
    } finally { sqlite.close(); }
  });

  it("journals a census rejection with its machine reason instead of a zero packet", async () => {
    const { sqlite, db } = openDb();
    try {
      const source = censusSourceFixture();
      const nowSec = source.clockSec + 15 * 60;
      insertSourceInput(sqlite, source);
      vi.setSystemTime(nowSec * 1_000);
      const { dependencies } = censusEvmDependencies({ pin: false });
      mocks.capture.mockResolvedValue({
        captureClockSec: nowSec, expectedAssetIds: [], attributionById: {}, journalRecords: [],
      });
      const metaById = new Map([["shadow-fixture",
        censusMeta("shadow-fixture", [{ chain: "ethereum", address: CENSUS_TOKEN }])]]);
      const window = {
        slotStartedAtSec: nowSec,
        deadlineMs: (nowSec + 180) * 1_000,
        minimumRemainingMs: 60_000,
      };

      const result = await syncSafetyScoreV9SupplyAttribution(
        db, CENSUS_CHAIN_RPCS, undefined, window, undefined,
        { metaById, dependencies: { evm: dependencies } },
      );
      // A shadow failure never degrades the attribution run.
      expect(result.status).toBe("ok");
      expect(JSON.parse(result.metadata ?? "{}").deploymentSupplyCensus).toMatchObject({
        status: "published",
        measuredAssetIds: [],
        rejectedByAssetId: {
          "shadow-fixture": ["census-rejected:missing-block-pin"],
        },
      });
      const stored = await readSafetyScoreV9DeploymentSupplyCensus(db, { clockSec: nowSec });
      const packet = stored.byId["shadow-fixture"]!;
      expect(packet.deployments).toEqual([]);
      expect(packet.conservation).toMatchObject({ rosterComplete: false, conserved: false });
      expect(packet.rejected).toEqual([{
        routeId: `ethereum:${CENSUS_TOKEN}`,
        code: "census-rejected:missing-block-pin",
      }]);
    } finally { sqlite.close(); }
  });

  it("does not re-observe a generation that already covers the fixed input", async () => {
    const { sqlite, db } = openDb();
    try {
      const source = censusSourceFixture();
      const nowSec = source.clockSec + 15 * 60;
      insertSourceInput(sqlite, source);
      vi.setSystemTime(nowSec * 1_000);
      const generation = createSafetyScoreV9DeploymentSupplyCensusGeneration({
        schemaVersion: 1,
        kind: "safety-score-v9-deployment-supply-census-generation",
        sourceBaseInputGenerationId: source.baseInputGenerationId,
        registryFingerprint: source.registryFingerprint,
        capturedAtSec: source.clockSec,
        censusById: {},
      });
      await writeSafetyScoreV9DeploymentSupplyCensusGeneration(db, generation);
      const { dependencies, multicall } = censusEvmDependencies();
      mocks.capture.mockResolvedValue({
        captureClockSec: nowSec, expectedAssetIds: [], attributionById: {}, journalRecords: [],
      });
      const window = {
        slotStartedAtSec: nowSec,
        deadlineMs: (nowSec + 180) * 1_000,
        minimumRemainingMs: 60_000,
      };

      const result = await syncSafetyScoreV9SupplyAttribution(
        db, CENSUS_CHAIN_RPCS, undefined, window, undefined, {
          metaById: new Map([["shadow-fixture",
            censusMeta("shadow-fixture", [{ chain: "ethereum", address: CENSUS_TOKEN }])]]),
          dependencies: { evm: dependencies },
        },
      );
      expect(JSON.parse(result.metadata ?? "{}").deploymentSupplyCensus).toMatchObject({
        status: "skipped",
        reason: "deployment-supply-census-generation-fresh",
        generationId: generation.generationId,
        capturedAtSec: source.clockSec,
      });
      expect(multicall).not.toHaveBeenCalled();
    } finally { sqlite.close(); }
  });
});

  it("fails closed before capture when the source fixed input is stale", async () => {
    const { sqlite, db } = openDb();
    try {
      const fixedInput = xautSourceFixture();
      vi.setSystemTime((fixedInput.clockSec + SOURCE_FIXED_INPUT_MAX_AGE_SEC + 1) * 1_000);
      insertSourceInput(sqlite, fixedInput);

      const result = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
      );

      expect(result).toMatchObject({
        status: "degraded",
        itemCount: 0,
        productivity: {
          productive: false,
          reason: "source-fixed-input-stale",
        },
      });
      expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
        stage: "source-fixed-input",
        reason: "source-fixed-input-stale",
        ageSec: SOURCE_FIXED_INPUT_MAX_AGE_SEC + 1,
      });
      expect(mocks.capture).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
