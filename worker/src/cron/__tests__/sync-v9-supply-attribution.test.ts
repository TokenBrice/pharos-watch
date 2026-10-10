import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_SOURCE_CACHE_KEY,
  serializeSafetyScoreV9SupplyAttributionSource,
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

const { syncSafetyScoreV9SupplyAttribution } =
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

describe("syncSafetyScoreV9SupplyAttribution", () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      });

      const first = await syncSafetyScoreV9SupplyAttribution(
        db,
        new Map(),
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
      });
      expect(mocks.capture).toHaveBeenCalledTimes(1);
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

  it("fails closed before capture when the source fixed input is stale", async () => {
    const { sqlite, db } = openDb();
    try {
      const fixedInput = xautSourceFixture();
      vi.setSystemTime((fixedInput.clockSec + 30 * 60 + 1) * 1_000);
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
        ageSec: 30 * 60 + 1,
      });
      expect(mocks.capture).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
