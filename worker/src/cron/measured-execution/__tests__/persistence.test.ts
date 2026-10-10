import { afterEach, describe, expect, it, vi } from "vitest";
import { makeNoopD1 } from "../../../test-helpers/noop-d1";

import {
  DEX_MEASURED_ADAPTER_PROFILE_IDS,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  validateDexMeasuredExecutionProfile,
  type DexMeasuredExecutionTarget,
} from "@shared/types/measured-execution";
import {
  DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE,
  getDexMeasuredHistoryFreshnessSec,
  isOperationalDexMeasuredFailure,
  loadLatestPublishedDexMeasuredQuoteEvidence,
  materializeDexMeasuredQuoteProfile,
} from "../evidence-reader";
import {
  publishDexMeasuredQuoteGeneration, publishDexMeasuredTargetInventory, pruneDexMeasuredExecutionGenerations,
  loadLatestPublishedDexMeasuredTargets,
  loadPositiveEmptyPoolQuarantines, readPositiveEmptyPoolProof, DEX_MEASURED_EMPTY_POOL_REPROBE_SEC,
} from "../persistence";
import { buildDexMeasuredExecutionProfile } from "../profiles";
import { makeV3Target } from "./measured-execution.test-support";
import { databases, evidenceDb, seedGeneration, seedMeasuredProducerAttempt } from "./persistence.test-support";

afterEach(() => databases.closeAll());

const fixtureTarget = (chain: string): DexMeasuredExecutionTarget =>
  makeV3Target({ chain });

function fixtureProfile(
  target: DexMeasuredExecutionTarget,
  identity: { targetGenerationId?: string; quoteGenerationId?: string; quotedAt?: number } = {},
) {
  return buildDexMeasuredExecutionProfile({
    target,
    targetGenerationId: identity.targetGenerationId ?? "target-generation",
    quoteGenerationId: identity.quoteGenerationId ?? "quote-generation",
    quotedAt: identity.quotedAt ?? 1_060,
    blockNumber: 25_536_894,
    endpointAddress: `0x${"44".repeat(20)}`,
    endpointCodeHash: `0x${"55".repeat(32)}`,
    points: [
      {
        amountInRaw: "1000000000",
        amountOutRaw: "970000000",
        callData: "0x01",
        returnData: "0x01",
        inputUsd: 1_000,
        outputUsd: 970,
        costBps: 300,
        passesCostBound: false,
      },
    ],
  });
}



describe("measured execution publication", () => {
  it("retains a three-hour history window for every measured adapter", () => {
    expect(getDexMeasuredHistoryFreshnessSec(DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap)).toBe(10_800);
    expect(getDexMeasuredHistoryFreshnessSec(DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg)).toBe(10_800);
    expect(getDexMeasuredHistoryFreshnessSec("uniswap-v3-quoter-v2")).toBe(10_800);
  });

  it("classifies StableSwap transport outages as operational but not semantic drift", () => {
    expect(isOperationalDexMeasuredFailure("rpc-failure")).toBe(true);
    expect(isOperationalDexMeasuredFailure("block-timestamp-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("runtime-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("registry-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("block-header-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("factory-code-unavailable")).toBe(true);
    expect(isOperationalDexMeasuredFailure("runtime-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("registry-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("block-header-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("block-hash-invalid")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-code-absent")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-code-hash-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("factory-membership-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("runtime-code-hash-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("registry-membership-mismatch")).toBe(false);
    expect(isOperationalDexMeasuredFailure("pool-revert")).toBe(false);
  });

  it("rejects an empty target generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredTargetInventory({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targets: [],
        capturedAt: 1_700_000_000,
      }),
    ).rejects.toThrow("empty DEX measured target generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an empty quote generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredQuoteGeneration({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targetGeneration: { generationId: "targets", targets: [], publishedAt: 1_700_000_000 },
        outcomes: [],
        quotedAt: 1_700_000_100,
      }),
    ).rejects.toThrow("empty DEX measured quote generation");
    expect(prepare).not.toHaveBeenCalled();
  });

});

describe("measured execution durable publication", () => {
  it("records the supplemental producer on the shared active quote surface", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const inventory = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 1_000 });
    await publishDexMeasuredQuoteGeneration({
      db,
      targetGeneration: { ...inventory, targets: [target], publishedAt: 1_000 },
      outcomes: [{ target, status: "failed", failureReason: "pool-revert" }],
      generationId: "supplemental-quotes",
      quotedAt: 1_060,
      producerScheduleKey: "halfHourlyMeasuredExecutionSupplemental",
    });
    expect(sqlite.prepare(
      "SELECT surface, producer_schedule_key, producer_job, producer_path, state FROM surface_publication_generations WHERE generation_id = ?",
    ).get("supplemental-quotes")).toEqual({
      surface: "dex-measured-execution-quotes",
      producer_schedule_key: "halfHourlyMeasuredExecutionSupplemental",
      producer_job: "sync-cl-exit-depth",
      producer_path: "halfHourlyMeasuredExecutionSupplemental",
      state: "published",
    });
  });

  it("retains the original empty-read clock and clears quarantine on the latest non-empty outcome", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const inventory = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 1_000 });
    const targetGeneration = { ...inventory, targets: [target], publishedAt: 1_000 };
    const proof = { adapterProfileId: target.adapterProfileId, targetId: target.targetId,
      emptyPoolObservation: { observedAtSec: 1_060, sourceQuoteGenerationId: "empty-first", blockNumber: 123,
        poolId: `0x${"11".repeat(32)}`, liquidity: "0", sqrtPriceX96: "10" },
      reprobeEligibleAtSec: 1_060 + DEX_MEASURED_EMPTY_POOL_REPROBE_SEC, reused: false };
    await publishDexMeasuredQuoteGeneration({ db, targetGeneration, generationId: "empty-first", quotedAt: 1_060,
      outcomes: [{ target, status: "failed", failureReason: "pool-uninitialized-or-empty", rawPayload: proof }] });
    const first = await loadPositiveEmptyPoolQuarantines(db, "active", [target.targetId]);
    expect(first.get(target.targetId)).toEqual(proof);
    expect(await loadPositiveEmptyPoolQuarantines(db, "shadow", [target.targetId])).toEqual(new Map());
    expect(await loadPositiveEmptyPoolQuarantines(db, "active", ["not-current"])).toEqual(new Map());
    await publishDexMeasuredQuoteGeneration({ db, targetGeneration, generationId: "empty-reused", quotedAt: 1_800,
      outcomes: [{ target, status: "failed", failureReason: "pool-uninitialized-or-empty", rawPayload: { ...proof, reused: true }, observedThisRun: false }] });
    expect((await loadPositiveEmptyPoolQuarantines(db, "active", [target.targetId])).get(target.targetId)?.emptyPoolObservation.observedAtSec).toBe(1_060);
    expect(sqlite.prepare("SELECT quoted_at FROM dex_measured_execution_quotes WHERE generation_id = ?").get("empty-reused")).toEqual({ quoted_at: null });
    await publishDexMeasuredQuoteGeneration({ db, targetGeneration, generationId: "refilled", quotedAt: 2_000,
      outcomes: [{ target, status: "measured", profile: fixtureProfile(target, {
        targetGenerationId: inventory.generationId, quoteGenerationId: "refilled", quotedAt: 2_000,
      }) }] });
    expect(await loadPositiveEmptyPoolQuarantines(db, "active", [target.targetId])).toEqual(new Map());
    expect(readPositiveEmptyPoolProof({ ...proof, reprobeEligibleAtSec: proof.reprobeEligibleAtSec + 1 })).toBeNull();
    expect(readPositiveEmptyPoolProof({ ...proof, emptyPoolObservation: { ...proof.emptyPoolObservation, liquidity: "malformed" } })).toBeNull();
  });
  it("persists profiles only for measured outcomes and raw payloads only for failures", async () => {
    const { db, sqlite } = databases.open();
    const measuredTarget = fixtureTarget("ethereum");
    const failedTarget = fixtureTarget("base");
    const targetGeneration = await publishDexMeasuredTargetInventory({ db, targets: [measuredTarget, failedTarget], capturedAt: 1_000 });
    const profile = fixtureProfile(measuredTarget, { targetGenerationId: targetGeneration.generationId });
    await publishDexMeasuredQuoteGeneration({ db, generationId: "quote-generation",
      targetGeneration: { ...targetGeneration, targets: [measuredTarget, failedTarget], publishedAt: 1_000 },
      outcomes: [
        { target: measuredTarget, status: "measured", profile, rawPayload: { secret: "discard" } },
        { target: failedTarget, status: "failed", failureReason: "pool-revert", rawPayload: { reason: "execution reverted" } },
      ], quotedAt: 1_060 });
    const rows = sqlite.prepare("SELECT target_id, quote_profile_json, raw_quote_payload_json FROM dex_measured_execution_quotes ORDER BY chain").all();
    expect(rows).toEqual([
      { target_id: failedTarget.targetId, quote_profile_json: null, raw_quote_payload_json: JSON.stringify({ reason: "execution reverted" }) },
      { target_id: measuredTarget.targetId, quote_profile_json: JSON.stringify(profile), raw_quote_payload_json: null },
    ]);
    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    expect(evidence?.byTargetId.get(measuredTarget.targetId)?.profile).toEqual(profile);
    expect(evidence?.byTargetId.get(failedTarget.targetId)).not.toHaveProperty("rawPayload");
  });

  it("publishes a complete quote generation when the post-insert COUNT readback hits transient D1 overload", async () => {
    const opened = databases.open();
    const target = fixtureTarget("ethereum");
    const published = await publishDexMeasuredTargetInventory({ db: opened.db, targets: [target], capturedAt: 1_000 });
    const profile = fixtureProfile(target, { targetGenerationId: published.generationId });
    let overloaded = false;
    const flakyDb = {
      ...opened.db,
      prepare(sql: string) {
        if (!overloaded && sql.includes("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes")) {
          overloaded = true;
          throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.");
        }
        return opened.db.prepare(sql);
      },
    } as D1Database;

    await publishDexMeasuredQuoteGeneration({ db: flakyDb, generationId: "quote-generation",
      targetGeneration: { generationId: published.generationId, targets: [target], publishedAt: 1_000 },
      outcomes: [{ target, status: "measured", profile }], quotedAt: 1_060 });

    expect(overloaded).toBe(true);
    expect(opened.sqlite.prepare(
      "SELECT state, published_rows FROM surface_publication_generations WHERE generation_id = 'quote-generation'",
    ).get()).toEqual({ state: "published", published_rows: 1 });
  });

  it("reconstructs sparse and all-deferred generations and rejects a tampered manifest", async () => {
    const { db, sqlite } = databases.open();
    const targets = [fixtureTarget("ethereum"), fixtureTarget("base")];
    const published = await publishDexMeasuredTargetInventory({ db, targets, capturedAt: 1_000 });
    const targetGeneration = { generationId: published.generationId, targets, publishedAt: 1_000 };
    const profile = fixtureProfile(targets[0]!, { targetGenerationId: published.generationId });
    for (const allDeferred of [false, true]) {
      const generationId = allDeferred ? "all-deferred" : "quote-generation";
      await publishDexMeasuredQuoteGeneration({ db, targetGeneration, generationId, quotedAt: allDeferred ? 1_100 : 1_060,
        outcomes: targets.map((target, index) => !allDeferred && index === 0
          ? { target, status: "measured" as const, profile }
          : { target, status: "failed" as const, failureReason: "budget-deferred" }) });
      expect(sqlite.prepare("SELECT target_id FROM dex_measured_execution_quotes WHERE generation_id = ?").all(generationId))
        .toEqual(allDeferred ? [] : [{ target_id: targets[0]!.targetId }]);
      const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
      expect(evidence?.quoteGenerationId).toBe(generationId);
      expect(evidence?.byTargetId.get(targets[1]!.targetId)).toMatchObject({ status: "failed", failureReason: "budget-deferred", profile: null });
      expect([...evidence!.byTargetId.keys()].sort()).toEqual(targets.map((target) => target.targetId).sort());
    }
    sqlite.prepare("UPDATE surface_publication_generations SET dependency_snapshot_json = json_set(dependency_snapshot_json, '$.targetIdsSha256', ?) WHERE generation_id = 'all-deferred'")
      .run("0".repeat(64));
    await expect(loadLatestPublishedDexMeasuredQuoteEvidence(db)).rejects.toThrow("incomplete");
  });

  it("rejects the same torn terminal row in full and selected evidence scans", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const published = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 1_000 });
    await publishDexMeasuredQuoteGeneration({
      db,
      generationId: "torn-quotes",
      targetGeneration: { ...published, targets: [target], publishedAt: 1_000 },
      outcomes: [{ target, status: "failed", failureReason: "pool-revert" }],
      quotedAt: 1_060,
    });
    sqlite.prepare(
      "UPDATE dex_measured_execution_quotes SET status = 'measured', failure_reason = NULL WHERE generation_id = ?",
    ).run("torn-quotes");

    for (const options of [undefined, { targetIds: [target.targetId] }]) {
      await expect(loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, options))
        .rejects.toThrow("torn terminal identity");
    }
  });

  it("loads all identities across current keyset pages with deferred profiles", async () => {
    const { db } = databases.open();
    const targets = Array.from({ length: DEX_MEASURED_CURRENT_EVIDENCE_PAGE_SIZE * 2 + 1 }, (_, index) => fixtureTarget(`test-chain-${index}`));
    const published = await publishDexMeasuredTargetInventory({ db, targets, capturedAt: 1_000 });
    const profiles = targets.map((target) => fixtureProfile(target, { targetGenerationId: published.generationId }));
    await publishDexMeasuredQuoteGeneration({ db, generationId: "quote-generation", quotedAt: 1_060,
      targetGeneration: { generationId: published.generationId, targets, publishedAt: 1_000 },
      outcomes: targets.map((target, index) => ({ target, status: "measured", profile: profiles[index]! })) });
    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, { deferProfiles: true });
    expect([...evidence!.byTargetId.keys()]).toEqual(targets.map((target) => target.targetId).sort());
    for (const [index, target] of targets.entries()) {
      const entry = evidence!.byTargetId.get(target.targetId)!;
      expect(entry.profile).toBeNull();
      expect(materializeDexMeasuredQuoteProfile(entry)).toEqual(profiles[index]);
    }
  });

  it("rejects duplicate target inventories without replacing the published inventory", async () => {
    const { db } = databases.open();
    const target = fixtureTarget("ethereum");
    const prior = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 1_000 });
    await expect(publishDexMeasuredTargetInventory({ db, targets: [target, target], capturedAt: 1_100 })).rejects.toThrow("duplicate target ids");
    expect(await loadLatestPublishedDexMeasuredTargets(db)).toEqual({ generationId: prior.generationId, targets: [target], publishedAt: 1_000 });
  });

  it("rejects duplicate, missing and foreign quote outcomes without replacing prior evidence", async () => {
    const { db } = evidenceDb({ target: fixtureTarget("ethereum"), latest: { status: "failed", failureReason: "pool-revert", profile: null } });
    const targets = [fixtureTarget("ethereum"), fixtureTarget("base")];
    const failed = (target: DexMeasuredExecutionTarget) => ({ target, status: "failed" as const, failureReason: "pool-revert" });
    for (const outcomes of [[failed(targets[0]!), failed(targets[0]!)], [failed(targets[0]!)], [failed(targets[0]!), failed(fixtureTarget("polygon"))]]) {
      await expect(publishDexMeasuredQuoteGeneration({ db, targetGeneration: { generationId: "candidate-targets", targets, publishedAt: 2_100 }, outcomes, quotedAt: 2_200 }))
        .rejects.toThrow("exactly cover");
      expect((await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.quoteGenerationId).toBe("quote-generation-latest");
    }
  });

  it("rejects incoherent terminal states without replacing prior evidence", async () => {
    const target = fixtureTarget("ethereum");
    const { db } = evidenceDb({ target, latest: { status: "failed", failureReason: "pool-revert", profile: null } });
    const profile = fixtureProfile(target);
    for (const outcome of [
      { target, status: "measured" as const },
      { target, status: "measured" as const, profile, failureReason: "pool-revert" },
      { target, status: "failed" as const, profile, failureReason: "pool-revert" },
      { target, status: "failed" as const, failureReason: "   " },
    ]) {
      await expect(publishDexMeasuredQuoteGeneration({ db, generationId: "quote-generation", targetGeneration: { generationId: "target-generation", targets: [target], publishedAt: 2_100 }, outcomes: [outcome], quotedAt: 2_200 }))
        .rejects.toThrow("invalid terminal state");
      expect((await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.quoteGenerationId).toBe("quote-generation-latest");
    }
  });

  it("rejects profile target and generation identity disagreement", async () => {
    const target = fixtureTarget("ethereum");
    const { db } = evidenceDb({ target, latest: { status: "failed", failureReason: "pool-revert", profile: null } });
    for (const profile of [
      fixtureProfile(fixtureTarget("base")),
      fixtureProfile(target, { targetGenerationId: "foreign-targets" }),
      fixtureProfile(target, { quoteGenerationId: "foreign-quotes" }),
    ]) {
      await expect(publishDexMeasuredQuoteGeneration({ db, generationId: "quote-generation", targetGeneration: { generationId: "target-generation", targets: [target], publishedAt: 2_100 }, outcomes: [{ target, status: "measured", profile }], quotedAt: 2_200 }))
        .rejects.toThrow("mismatched generation identity");
      expect((await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.quoteGenerationId).toBe("quote-generation-latest");
    }
  });

  it("rejects post-write count mismatches and preserves both publication pointers", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const prior = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 1_000 });
    const targetGeneration = { generationId: prior.generationId, targets: [target], publishedAt: 1_000 };
    await publishDexMeasuredQuoteGeneration({ db, generationId: "prior-quotes", targetGeneration,
      outcomes: [{ target, status: "failed", failureReason: "pool-revert" }], quotedAt: 1_060 });
    sqlite.exec(`CREATE TRIGGER drop_candidate_target AFTER INSERT ON dex_measured_execution_targets
      BEGIN DELETE FROM dex_measured_execution_targets WHERE generation_id = NEW.generation_id; END;
      CREATE TRIGGER drop_candidate_quote AFTER INSERT ON dex_measured_execution_quotes
      BEGIN DELETE FROM dex_measured_execution_quotes WHERE generation_id = NEW.generation_id; END;`);
    await expect(publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: 2_000 })).rejects.toThrow("row mismatch");
    await expect(publishDexMeasuredQuoteGeneration({ db, generationId: "broken-quotes", targetGeneration,
      outcomes: [{ target, status: "failed", failureReason: "pool-revert" }], quotedAt: 2_060 })).rejects.toThrow("row mismatch");
    expect(await loadLatestPublishedDexMeasuredTargets(db)).toEqual(targetGeneration);
    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    expect(evidence?.quoteGenerationId).toBe("prior-quotes");
    expect([...evidence!.byTargetId.keys()]).toEqual([target.targetId]);
    expect(sqlite.prepare("SELECT state FROM surface_publication_generations WHERE generation_id = 'broken-quotes'").get()).toEqual({ state: "failed" });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_targets").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes").get()).toEqual({ count: 1 });
  });
});

describe("measured execution last-known-good selection", () => {
  it("selects only complete superseded history inside the inclusive lookback", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    seedGeneration(sqlite, { generationId: "latest", targetGenerationId: "latest-targets",
      publishedAt: 20_000, state: "published", rows: [{ target, status: "failed", failureReason: "pool-revert" }] });
    const candidates = ["complete", "cutoff", "old", "failed", "candidate", "missing-row", "wrong-count"];
    for (const name of candidates) {
      const historicalTarget = fixtureTarget(name);
      const publishedAt = name === "cutoff" ? 9_200 : name === "old" ? 9_199 : 19_000;
      seedGeneration(sqlite, { generationId: name, targetGenerationId: `targets-${name}`, publishedAt,
        state: name === "failed" || name === "candidate" ? name : "superseded",
        rows: [{ target: historicalTarget, profile: fixtureProfile(historicalTarget, {
          targetGenerationId: `targets-${name}`, quoteGenerationId: name, quotedAt: publishedAt,
        }) }] });
    }
    sqlite.exec("DELETE FROM dex_measured_execution_quotes WHERE generation_id = 'missing-row'");
    sqlite.exec("UPDATE surface_publication_generations SET published_rows = 2 WHERE generation_id = 'wrong-count'");
    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    expect([...evidence!.byTargetId.keys()].sort()).toEqual([
      target.targetId, fixtureTarget("complete").targetId, fixtureTarget("cutoff").targetId,
    ].sort());
    expect(evidence?.byTargetId.get(fixtureTarget("cutoff").targetId)).toMatchObject({
      quoteGenerationId: "cutoff", resolution: "last-known-good",
    });
  });
  it.each(["request-budget-exhausted", "block-header-unavailable"])(
    "retains original source time across a latest %s operational failure", async (failureReason) => {
    const measuredTarget = fixtureTarget("ethereum");
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason,
        profile: null,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      deferProfiles: true,
    });
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "measured",
      failureReason: null,
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
      resolution: "last-known-good",
      latestFailureReason: failureReason,
    });
    expect(entry?.profile).toBeNull();
    expect(materializeDexMeasuredQuoteProfile(entry!)?.quotedAt).toBe(1_900);
    expect(materializeDexMeasuredQuoteProfile(entry!)?.quoteGenerationId).toBe("quote-generation-lkg");
    const retainedProfile = materializeDexMeasuredQuoteProfile(entry!)!;
    expect(validateDexMeasuredExecutionProfile({
      profile: retainedProfile,
      quotedTarget: measuredTarget,
      currentTarget: measuredTarget,
      expectedTargetGenerationId: "target-generation-lkg",
      expectedQuoteGenerationId: "quote-generation-lkg",
      nowSec: retainedProfile.quotedAt + DEX_MEASURED_FRESHNESS_MAX_SEC + 1,
    })).toContain("stale-observation");
    expect(entry?.observationHistory).toMatchObject({
      completeProducerCycleCount: 2,
      successfulObservationCount: 1,
      consecutiveSuccessCount: 0,
      latestOperationalFailureAt: 2_010,
    });
  });

  it("logs an LKG enrichment read failure while returning current evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const { db: currentDb } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "request-budget-exhausted",
        profile: null,
      },
      historical: [],
    });
    const prepareCurrent = currentDb.prepare.bind(currentDb);
    const db = makeNoopD1({
      prepare: vi.fn((query: string) => {
        if (query.includes("SELECT history_generation.generation_id")) {
          return {
            bind: () => ({
              all: async () => {
                throw new Error("forced LKG D1 read failure");
              },
            }),
          };
        }
        return prepareCurrent(query);
      }),
    });
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);

    expect(evidence?.byTargetId.get(measuredTarget.targetId)).toMatchObject({
      status: "failed",
      failureReason: "request-budget-exhausted",
      resolution: "latest",
    });
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"measured_execution.lkg_enrichment_failed"'),
    );
    consoleWarn.mockRestore();
  });

  it("preserves mature conservative history across a latest operational failure", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const newerProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g2",
      quoteGenerationId: "quote-generation-g2",
      quotedAt: 1_900,
    });
    const olderProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g1",
      quoteGenerationId: "quote-generation-g1",
      quotedAt: 1_800,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "quoter-rpc-unavailable",
        profile: null,
      },
      historical: [
        { target: measuredTarget, profile: newerProfile },
        { target: measuredTarget, profile: olderProfile },
      ],
    });

    const entry = (await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      resolution: "last-known-good",
      quoteGenerationId: "quote-generation-g2",
      observationHistory: {
        completeProducerCycleCount: 3,
        successfulObservationCount: 2,
        consecutiveSuccessCount: 0,
        latestOperationalFailureAt: 2_010,
        conservativeStatistic: "pointwise-minimum",
      },
    });
  });

  it("does not mask a deterministic or semantic failure with older evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "failed",
      failureReason: "pool-revert",
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      resolution: "latest",
    });
    expect(entry?.profile).toBeNull();
  });

  it("does not search past a historical deterministic failure for LKG evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const olderProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-g1",
      quoteGenerationId: "quote-generation-g1",
      quotedAt: 1_800,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "failed",
        failureReason: "request-budget-exhausted",
        profile: null,
      },
      historical: [
        {
          target: measuredTarget,
          status: "failed",
          failureReason: "pool-revert",
          generationId: "quote-generation-g2",
          targetGenerationId: "target-generation-g2",
          publishedAt: 1_900,
        },
        { target: measuredTarget, profile: olderProfile, publishedAt: 1_800 },
      ],
    });

    const entry = (await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "failed",
      failureReason: "request-budget-exhausted",
      resolution: "latest",
      quoteGenerationId: "quote-generation-latest",
    });
    expect(entry?.profile).toBeNull();
    expect(entry?.observationHistory).toBeUndefined();
  });

  it("keeps a latest measured-zero profile instead of substituting older evidence", async () => {
    const measuredTarget = fixtureTarget("ethereum");
    const latestProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-latest",
      quoteGenerationId: "quote-generation-latest",
      quotedAt: 2_000,
    });
    const historicalProfile = fixtureProfile(measuredTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: measuredTarget,
      latest: {
        status: "measured",
        failureReason: null,
        profile: latestProfile,
      },
      historical: [{ target: measuredTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const entry = evidence?.byTargetId.get(measuredTarget.targetId);

    expect(entry).toMatchObject({
      status: "measured",
      quoteGenerationId: "quote-generation-latest",
      targetGenerationId: "target-generation-latest",
      resolution: "latest",
      latestFailureReason: null,
    });
    expect(entry?.profile?.capacityCurve.every((point) => point.executableUsd === 0)).toBe(true);
    expect(
      entry?.observationHistory?.conservativeCapacityCurve.every((point) => point.executableUsd === 0),
    ).toBe(true);
  });

  it("exposes exact-identity historical evidence for a target absent from the latest quote generation", async () => {
    const latestTarget = fixtureTarget("ethereum");
    const historicalTarget = fixtureTarget("base");
    const historicalProfile = fixtureProfile(historicalTarget, {
      targetGenerationId: "target-generation-lkg",
      quoteGenerationId: "quote-generation-lkg",
      quotedAt: 1_900,
    });
    const { db } = evidenceDb({
      target: latestTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical: [{ target: historicalTarget, profile: historicalProfile }],
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    const latestEntry = evidence?.byTargetId.get(latestTarget.targetId);
    const historicalEntry = evidence?.byTargetId.get(historicalTarget.targetId);

    expect(latestEntry).toMatchObject({ status: "failed", failureReason: "pool-revert", resolution: "latest" });
    expect(historicalEntry).toMatchObject({
      status: "measured",
      resolution: "last-known-good",
      latestFailureReason: "quote-missing",
      quoteGenerationId: "quote-generation-lkg",
      targetGenerationId: "target-generation-lkg",
    });
  });

  it("loads and summarizes large historical target sets in bounded batches", async () => {
    const latestTarget = fixtureTarget("ethereum");
    const historical = Array.from({ length: 65 }, (_, index) => {
      const target = fixtureTarget(`history-${index}`);
      return {
        target,
        profile: fixtureProfile(target, {
          targetGenerationId: `target-generation-${index}`,
          quoteGenerationId: `quote-generation-${index}`,
          quotedAt: 1_900,
        }),
        publishedAt: 1_900,
      };
    });
    const { db } = evidenceDb({
      target: latestTarget,
      latest: {
        status: "failed",
        failureReason: "pool-revert",
        profile: null,
      },
      historical,
    });

    const evidence = await loadLatestPublishedDexMeasuredQuoteEvidence(db);

    expect(evidence?.byTargetId).toHaveLength(66);
    expect(evidence?.byTargetId.get(historical[64]!.target.targetId)).toMatchObject({
      status: "measured",
      resolution: "last-known-good",
      quoteGenerationId: "quote-generation-64",
    });
  });
});

describe("measured execution clock-bounded cohort reads", () => {
  it("retains twelve quarter-hour observations without leaking later supplemental history", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const targetGenerationId = "quarter-hour-targets";
    for (let opportunity = 0; opportunity < 12; opportunity++) {
      const generationId = `quarter-hour-quotes-${opportunity}`;
      const quotedAt = 1_000 + opportunity * 900;
      seedGeneration(sqlite, {
        generationId, targetGenerationId, publishedAt: quotedAt + 60,
        state: opportunity === 11 ? "published" : "superseded",
        rows: [{ target, profile: fixtureProfile(target, { targetGenerationId, quoteGenerationId: generationId, quotedAt }) }],
      });
    }
    const latest = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    expect(latest?.quoteGenerationId).toBe("quarter-hour-quotes-11");
    expect(latest?.byTargetId.get(target.targetId)?.observationHistory).toMatchObject({
      completeProducerCycleCount: 12, successfulObservationCount: 12,
      observationWindowStartedAt: 1_060, observationWindowEndedAt: 10_960,
    });
    const clocked = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, { publishedAtCeilingSec: 5_560 });
    expect(clocked?.quoteGenerationId).toBe("quarter-hour-quotes-5");
    expect(clocked?.byTargetId.get(target.targetId)?.observationHistory).toMatchObject({
      completeProducerCycleCount: 6, successfulObservationCount: 6,
      observationWindowEndedAt: 5_560,
    });
  });

  it("reads the newest cohort published at or before the consumer clock", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const targetGenerationId = "target-generation-clocked";
    const cohorts = [
      { generationId: "quote-generation-admitted", publishedAt: 1_300, state: "superseded" as const, quotedAt: 1_000 },
      { generationId: "quote-generation-displaced", publishedAt: 1_600, state: "superseded" as const, quotedAt: 1_240 },
      { generationId: "quote-generation-latest", publishedAt: 1_900, state: "published" as const, quotedAt: 1_600 },
    ];
    for (const cohort of cohorts) {
      seedGeneration(sqlite, { generationId: cohort.generationId, targetGenerationId,
        publishedAt: cohort.publishedAt, state: cohort.state,
        rows: [{ target, profile: fixtureProfile(target, {
          targetGenerationId,
          quoteGenerationId: cohort.generationId,
          quotedAt: cohort.quotedAt,
        }) }] });
    }

    // The consumer's pinned observation clock: the hourly DEX scoring run pins
    // routeObservedAt to its source slot, which measured cohort publication can
    // land after.
    const clockSec = 1_400;
    const unbounded = await loadLatestPublishedDexMeasuredQuoteEvidence(db);
    expect(unbounded?.quoteGenerationId).toBe("quote-generation-latest");
    expect(unbounded?.byTargetId.get(target.targetId)?.observationHistory?.observationWindowEndedAt)
      .toBeGreaterThan(clockSec);

    const clocked = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      publishedAtCeilingSec: clockSec,
    });
    expect(clocked?.quoteGenerationId).toBe("quote-generation-admitted");
    const entry = clocked?.byTargetId.get(target.targetId);
    expect(entry?.profile?.quoteGenerationId).toBe("quote-generation-admitted");
    // Admitting the cohort is not enough: a cohort published after the clock
    // must not re-enter the observation history either, or its window end is
    // what the no-lookahead `future-history` guard rejects.
    expect(entry?.observationHistory?.observationWindowEndedAt).toBeLessThanOrEqual(clockSec);

    const deferred = await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      deferProfiles: true,
      publishedAtCeilingSec: clockSec,
    });
    const deferredEntry = deferred?.byTargetId.get(target.targetId);
    expect(deferredEntry && materializeDexMeasuredQuoteProfile(deferredEntry)?.quoteGenerationId)
      .toBe("quote-generation-admitted");
  });

  it("keeps last-known-good resolution inside the consumer clock", async () => {
    const { db, sqlite } = databases.open();
    const measured = fixtureTarget("ethereum");
    const deferred = fixtureTarget("base");
    const targetGenerationId = "target-generation-lkg-clocked";
    const cohorts = [
      { generationId: "quote-generation-admitted", publishedAt: 1_300, state: "superseded" as const, quotedAt: 1_000 },
      { generationId: "quote-generation-displaced", publishedAt: 1_600, state: "superseded" as const, quotedAt: 1_240 },
      { generationId: "quote-generation-latest", publishedAt: 1_900, state: "published" as const, quotedAt: 1_600 },
    ];
    for (const cohort of cohorts) {
      seedGeneration(sqlite, { generationId: cohort.generationId, targetGenerationId,
        publishedAt: cohort.publishedAt, state: cohort.state,
        rows: [
          { target: measured, profile: fixtureProfile(measured, {
            targetGenerationId, quoteGenerationId: cohort.generationId, quotedAt: cohort.quotedAt,
          }) },
          // The deferred direction is only ever measured by the displaced cohort,
          // so a clock-pinned read has no admissible evidence for it at all.
          cohort.generationId === "quote-generation-displaced"
            ? { target: deferred, profile: fixtureProfile(deferred, {
              targetGenerationId, quoteGenerationId: cohort.generationId, quotedAt: cohort.quotedAt,
            }) }
            : { target: deferred, status: "failed" as const, failureReason: "budget-deferred" },
        ] });
    }

    const clockSec = 1_400;
    expect((await loadLatestPublishedDexMeasuredQuoteEvidence(db))?.byTargetId.get(deferred.targetId))
      .toMatchObject({ status: "measured", resolution: "last-known-good", quoteGenerationId: "quote-generation-displaced" });

    expect((await loadLatestPublishedDexMeasuredQuoteEvidence(db, undefined, {
      publishedAtCeilingSec: clockSec,
    }))?.byTargetId.get(deferred.targetId))
      .toMatchObject({ status: "failed", resolution: "latest" });
  });
});

describe("measured execution generation prune", () => {
  it("prunes terminal rows in bounded batches while retaining referenced and cutoff generations", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const nowSec = 100_000;
    const cutoff = nowSec - 14_400;
    for (let index = 0; index < 18; index++) {
      seedGeneration(sqlite, { generationId: `old-${index}`, targetGenerationId: `targets-${index}`,
        publishedAt: cutoff - 100 + index, state: index % 2 ? "failed" : "rejected",
        rows: [{ target, status: "failed", failureReason: "pool-revert" }] });
    }
    for (const [generationId, publishedAt, state] of [
      ["published", cutoff - 200, "published"], ["candidate", cutoff - 190, "candidate"],
      ["cutoff", cutoff, "superseded"], ["recent", cutoff + 1, "superseded"],
    ] as const) {
      seedGeneration(sqlite, { generationId, targetGenerationId: `targets-${generationId}`,
        publishedAt, state, rows: [{ target, status: "failed", failureReason: "pool-revert" }] });
    }
    const quoteIds = () => sqlite.prepare("SELECT generation_id FROM dex_measured_execution_quotes ORDER BY generation_id")
      .all().map((row: Record<string, unknown>) => row.generation_id);
    const first = await pruneDexMeasuredExecutionGenerations(db, nowSec);
    expect(first).toMatchObject({ cutoff, deletedQuoteRows: 16, deletedTargetRows: 14,
      deletedGenerationRows: 16, deletedRows: 46, error: null });
    expect(quoteIds()).toEqual(["candidate", "cutoff", "old-16", "old-17", "published", "recent"]);
    for (let pass = 0; pass < 3; pass++) await pruneDexMeasuredExecutionGenerations(db, nowSec);
    expect(quoteIds()).toEqual(["candidate", "cutoff", "published", "recent"]);
    expect(sqlite.prepare("SELECT generation_id FROM dex_measured_execution_targets ORDER BY generation_id").all()
      .map((row: Record<string, unknown>) => row.generation_id)).toEqual(["targets-candidate", "targets-cutoff", "targets-published", "targets-recent"]);
    expect(sqlite.prepare("SELECT generation_id FROM surface_publication_generations ORDER BY generation_id").all()
      .map((row: Record<string, unknown>) => row.generation_id)).toEqual([
        "candidate", "cutoff", "published", "recent",
        "targets-candidate", "targets-cutoff", "targets-published", "targets-recent",
      ]);
  });

  it("drains a provenance-known abandoned active candidate by physical rows, then its empty ledger", async () => {
    const { db, sqlite } = databases.open();
    const nowSec = 100_000;
    const generationId = "abandoned-active-targets";
    seedMeasuredProducerAttempt(sqlite, { job: "sync-dex-liquidity", scheduleKey: "halfHourlyChartsOffset",
      invocationId: "invocation", clockSec: nowSec - 14_401 });
    // Cleanup may run beside a newer invocation of the same producer job.
    sqlite.prepare(`INSERT INTO cron_leases VALUES ('sync-dex-liquidity', 'unrelated-owner', ?, ?, ?)`).run(nowSec + 900, nowSec, nowSec);
    sqlite.prepare(`INSERT INTO surface_publication_generations
      (surface, generation_id, started_at, state, expected_rows, producer_schedule_key, producer_job, producer_path, producer_kind, invocation_id)
      VALUES ('dex-measured-execution-targets', ?, ?, 'candidate', 37,
        'halfHourlyChartsOffset', 'sync-dex-liquidity', 'halfHourlyChartsOffset', 'scheduled-job', 'invocation')`)
      .run(generationId, nowSec - 14_401);
    const targetInsert = sqlite.prepare(`INSERT INTO dex_measured_execution_targets
      (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain, pool_id, captured_at, target_json)
      VALUES (?, ?, 'usdc-circle', 'uniswap-v3-quoter-v2', 'uniswap-v3', 'ethereum', ?, ?, '{}')`);
    for (let index = 0; index < 37; index++) targetInsert.run(generationId, `target-${index}`, `pool-${index}`, nowSec - 14_401);
    const count = () => Number(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_targets WHERE generation_id = ?").get(generationId)!.count);
    const ledgerQuery = sqlite.prepare("SELECT state FROM surface_publication_generations WHERE generation_id = ?");
    expect(await pruneDexMeasuredExecutionGenerations(db, nowSec)).toMatchObject({
      deletedTargetRows: 16, deletedGenerationRows: 0, error: null,
    });
    expect(count()).toBe(21);
    expect(ledgerQuery.get(generationId)).toMatchObject({ state: "candidate" });
    expect(await pruneDexMeasuredExecutionGenerations(db, nowSec)).toMatchObject({ deletedTargetRows: 16, error: null });
    expect(count()).toBe(5);
    expect(await pruneDexMeasuredExecutionGenerations(db, nowSec)).toMatchObject({
      deletedTargetRows: 5, deletedGenerationRows: 1, error: null,
    });
    expect(count()).toBe(0);
    expect(ledgerQuery.get(generationId)).toBeUndefined();
  });

  it.each(["lease", "progress", "slot", "child", "quote-reference", "ledger-reference", "malformed-reference", "unknown-owner", "missing-terminal", "cutoff", "validated", "published", "shadow"] as const)(
    "retains an old candidate without positive no-owner/no-reference proof: %s",
    async (protection) => {
      const { db, sqlite } = databases.open();
      const nowSec = 100_000;
      const generationId = "protected-active-targets";
      seedMeasuredProducerAttempt(sqlite, { job: "sync-dex-liquidity", scheduleKey: "halfHourlyChartsOffset",
        invocationId: "invocation", clockSec: nowSec - 14_401 });
      sqlite.prepare(`INSERT INTO surface_publication_generations
        (surface, generation_id, started_at, state, expected_rows, producer_schedule_key, producer_job, producer_path, producer_kind, invocation_id)
        VALUES ('dex-measured-execution-targets', ?, ?, 'candidate', 1,
          'halfHourlyChartsOffset', 'sync-dex-liquidity', 'halfHourlyChartsOffset', 'scheduled-job', 'invocation')`)
        .run(generationId, nowSec - 14_401);
      const target = fixtureTarget("ethereum");
      sqlite.prepare(`INSERT INTO dex_measured_execution_targets
        (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain, pool_id, captured_at, target_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(generationId, target.targetId, target.stablecoinId, target.adapterProfileId, target.protocol,
          target.chain, target.poolId, target.capturedAt, JSON.stringify(target));
      if (protection === "lease") sqlite.prepare(`INSERT INTO cron_leases VALUES ('sync-dex-liquidity', 'owner', ?, ?, ?)`).run(nowSec, nowSec, nowSec);
      if (protection === "progress") sqlite.prepare(`INSERT INTO cron_run_progress (job, started_at, updated_at, lease_owner) VALUES ('sync-dex-liquidity', ?, ?, 'owner')`).run(nowSec - 20_000, nowSec - 20_000);
      if (protection === "slot" || protection === "child") {
        sqlite.prepare(`INSERT INTO cron_slot_executions
          (slot_key, slot_started_at, state, execution_owner, started_at, updated_at, invocation_id)
          VALUES ('halfHourlyChartsOffset', ?, ?, 'owner', ?, ?, 'invocation')`)
          .run(nowSec, protection === "slot" ? "running" : "completed", nowSec, nowSec);
      }
      if (protection === "child") sqlite.prepare(`INSERT INTO scheduled_child_attempts
        (attempt_key, schedule_key, slot_started_at, job, producer_path, producer_kind, invocation_id, attempt_no,
         execution_schedule_key, execution_slot_started_at, execution_invocation_id, execution_generation, execution_owner)
        VALUES ('attempt', 'halfHourlyChartsOffset', ?, 'sync-dex-liquidity', 'halfHourlyChartsOffset', 'scheduled-job', 'invocation', 1,
          'halfHourlyChartsOffset', ?, 'invocation', 1, 'owner')`).run(nowSec, nowSec);
      if (protection === "quote-reference") seedGeneration(sqlite, {
        generationId: "current-quote-reference", targetGenerationId: generationId, publishedAt: nowSec,
        state: "published", rows: [{ target, status: "failed", failureReason: "pool-revert" }],
      });
      if (protection === "ledger-reference" || protection === "malformed-reference") {
        sqlite.prepare(`INSERT INTO surface_publication_generations
          (surface, generation_id, started_at, state, dependency_snapshot_json)
          VALUES ('dex-measured-execution-quotes', 'empty-quote-reference', ?, 'published', ?)`)
          .run(nowSec, protection === "ledger-reference" ? JSON.stringify({ targetGenerationId: generationId }) : "{invalid");
      }
      if (protection === "unknown-owner") sqlite.prepare("UPDATE surface_publication_generations SET producer_job = NULL WHERE generation_id = ?").run(generationId);
      if (protection === "missing-terminal") sqlite.prepare("DELETE FROM cron_runs WHERE invocation_id = 'invocation'").run();
      if (protection === "cutoff") sqlite.prepare("UPDATE surface_publication_generations SET started_at = ? WHERE generation_id = ?").run(nowSec - 14_400, generationId);
      if (protection === "validated") sqlite.prepare("UPDATE surface_publication_generations SET validated_at = ? WHERE generation_id = ?").run(nowSec - 14_401, generationId);
      if (protection === "published") sqlite.prepare("UPDATE surface_publication_generations SET state = 'published', published_at = ? WHERE generation_id = ?").run(nowSec - 14_401, generationId);
      if (protection === "shadow") sqlite.prepare("UPDATE surface_publication_generations SET surface = 'dex-shadow-measured-execution-targets' WHERE generation_id = ?").run(generationId);
      expect(await pruneDexMeasuredExecutionGenerations(db, nowSec)).toMatchObject({ deletedTargetRows: 0, deletedGenerationRows: 0, error: null });
      expect(sqlite.prepare("SELECT generation_id FROM dex_measured_execution_targets WHERE generation_id = ?").get(generationId)).toBeDefined();
      expect(sqlite.prepare("SELECT generation_id FROM surface_publication_generations WHERE generation_id = ?").get(generationId)).toBeDefined();
    },
  );

  it("attributes target and quote candidates to their exact fenced scheduled producer", async () => {
    const { db, sqlite } = databases.open();
    const clockSec = 100_000;
    seedMeasuredProducerAttempt(sqlite, { job: "sync-dex-liquidity", scheduleKey: "halfHourlyChartsOffset",
      invocationId: "target-invocation", clockSec, terminal: false });
    const target = fixtureTarget("ethereum");
    const targets = await publishDexMeasuredTargetInventory({ db, targets: [target], capturedAt: clockSec });
    expect(sqlite.prepare("SELECT invocation_id FROM surface_publication_generations WHERE generation_id = ?").get(targets.generationId)!.invocation_id).toBe("target-invocation");
    seedMeasuredProducerAttempt(sqlite, { job: "sync-cl-exit-depth", scheduleKey: "halfHourlyMeasuredExecution",
      invocationId: "quote-invocation", clockSec, terminal: false });
    const quotes = await publishDexMeasuredQuoteGeneration({ db,
      targetGeneration: { ...targets, targets: [target], publishedAt: clockSec },
      outcomes: [{ target, status: "failed", failureReason: "pool-revert" }], quotedAt: clockSec });
    expect(sqlite.prepare("SELECT invocation_id FROM surface_publication_generations WHERE generation_id = ?").get(quotes.generationId)!.invocation_id).toBe("quote-invocation");
  });

  it("bounds a dense terminal generation delete to physical rows rather than generation count", async () => {
    const { db, sqlite } = databases.open();
    const target = fixtureTarget("ethereum");
    const rows = Array.from({ length: 37 }, (_, index) => ({
      target: { ...target, targetId: `dense-${index}` }, status: "failed" as const, failureReason: "pool-revert",
    }));
    seedGeneration(sqlite, { generationId: "dense-quotes", targetGenerationId: "dense-targets",
      publishedAt: 10_000, state: "failed", rows });
    const result = await pruneDexMeasuredExecutionGenerations(db, 100_000);
    expect(result).toMatchObject({ deletedQuoteRows: 16, deletedTargetRows: 0, deletedGenerationRows: 0, error: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes").get()!.count).toBe(21);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_targets").get()!.count).toBe(37);
  });

  it("reports cleanup errors without throwing after publication", async () => {
    const db = makeNoopD1({
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error("retention unavailable");
          },
        }),
      }),
    });

    const retention = await pruneDexMeasuredExecutionGenerations(db, 1_700_000_000);

    expect(retention.deletedRows).toBe(0);
    expect(retention.error).toBe("retention unavailable");
  });
});
