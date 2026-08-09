import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupplyAttributionJournalV1,
} from "@shared/lib/safety-score-v9-supply-attribution-journal";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  buildNativeV9InputCacheEntry,
  NATIVE_V9_INPUT_CACHE_KEY,
} from "../../lib/safety-score-v9-native-input";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import {
  parseSafetyScoreV9SupplyAttributionGeneration,
  SAFETY_SCORE_V9_SUPPLY_ATTRIBUTION_GENERATION_CACHE_KEY,
} from "../../lib/safety-score-v9-supply-attribution-generation";
import { createNativeSafetyScoreV9FullRegistryInput } from "../../lib/__tests__/fixtures/safety-score-v9-full-registry-input";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
}));

vi.mock(
  "../../lib/safety-score-v9-supply-attribution",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("../../lib/safety-score-v9-supply-attribution")
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

describe("syncSafetyScoreV9SupplyAttribution", () => {
  beforeEach(() => {
    mocks.capture.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes one exact degraded generation and retries only after the producer cooldown", async () => {
    const { sqlite, db } = openDb();
    try {
      const fixedInput = createNativeSafetyScoreV9FullRegistryInput();
      const nowSec = fixedInput.clockSec + 15 * 60;
      vi.setSystemTime(nowSec * 1_000);
      const cacheEntry = await buildNativeV9InputCacheEntry(
        fixedInput,
        buildSafetyScoreV9InputIdentity({
          methodologyVersion: fixedInput.methodologyVersion,
          baseInputGenerationId: fixedInput.baseInputGenerationId,
          publicationGenerationId: fixedInput.sourceGeneration,
        }),
      );
      sqlite
        .prepare(
          "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          NATIVE_V9_INPUT_CACHE_KEY,
          cacheEntry.value,
          fixedInput.clockSec,
        );
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
      expect(first.status).toBe("degraded");
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
      const fixedInput = createNativeSafetyScoreV9FullRegistryInput();
      vi.setSystemTime((fixedInput.clockSec + 30 * 60 + 1) * 1_000);
      const cacheEntry = await buildNativeV9InputCacheEntry(
        fixedInput,
        buildSafetyScoreV9InputIdentity({
          methodologyVersion: fixedInput.methodologyVersion,
          baseInputGenerationId: fixedInput.baseInputGenerationId,
          publicationGenerationId: fixedInput.sourceGeneration,
        }),
      );
      sqlite
        .prepare(
          "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        )
        .run(
          NATIVE_V9_INPUT_CACHE_KEY,
          cacheEntry.value,
          fixedInput.clockSec,
        );

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
