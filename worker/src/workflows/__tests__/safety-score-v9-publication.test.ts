import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(fixtures.closeAll);
afterEach(() => vi.restoreAllMocks());
import type {
  WorkflowStep,
  WorkflowStepConfig,
} from "cloudflare:workers";

const { computeSafetyScoreV9, parseNativeV9InputCacheArtifact } = vi.hoisted(
  () => ({
    computeSafetyScoreV9: vi.fn(),
    parseNativeV9InputCacheArtifact: vi.fn(async () => ({
      input: {
        sourceGeneration: "report-cards:v9:1788433200",
        baseInputGenerationId: "report-cards-input:v1:1788433200",
        clockSec: 1788433200,
      },
    })),
  }),
);

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
}));

vi.mock("../../lib/safety-score-v9/native-input", () => ({
  NATIVE_V9_INPUT_CACHE_KEY: "report-cards:fixed-input:exact",
  parseNativeV9InputCacheArtifact,
}));

vi.mock("../../cron/compute-safety-score-v9", () => ({
  computeSafetyScoreV9,
}));

import {
  SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX,
  SAFETY_SCORE_V9_WORKFLOW_JOB,
  createSafetyScoreV9ShadowCaptureDatabase,
  gateSafetyScoreV9ShadowPublication,
  runSafetyScoreV9PublicationWorkflow,
  safetyScoreV9WorkflowInstanceId,
  safetyScoreV9WorkflowSlotStartedAt,
  writeSafetyScoreV9ShadowPublication,
} from "../safety-score-v9-publication";
import {
  safetyScoreV9WorkflowInstanceId as scheduledInstanceId,
} from "../../handlers/scheduled/v9-publication";


function d1Result(changes = 0): D1Result {
  return {
    success: true,
    meta: { changes },
    results: [],
  } as unknown as D1Result;
}

function createWorkflowDb() {
  const fixture = fixtures.open();
  fixture.sqlite.prepare("INSERT INTO cache VALUES (?, ?, ?)").run(
    "report-cards:fixed-input:exact", "fixed-input-envelope", 1788433200,
  );
  return fixture;
}

async function compileCanonicalPublication(compilerDb: D1Database) {
  for (const [key, value] of [
    ["report-cards:v9", "canonical-publication-envelope"],
    ["report-cards:v9:publication-health", "canonical-health"],
    ["report-cards:v9:last-attempt", "canonical-attempt"],
  ] as const) {
    await compilerDb.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(key, value, 1788433200).run();
  }
  return {
    status: "ok",
    itemCount: 200,
    metadata: JSON.stringify({
      sourceGenerationId: "report-cards:v9:1788433200",
      baseInputGenerationId: "report-cards-input:v1:1788433200",
      publication: { status: "published" },
    }),
  };
}

class ReplayFakeStep {
  readonly calls: Array<{ name: string; config: WorkflowStepConfig }> = [];
  readonly results = new Map<string, unknown>();

  async do(
    name: string,
    config: WorkflowStepConfig,
    callback: () => Promise<unknown>,
  ): Promise<unknown> {
    this.calls.push({ name, config });
    if (this.results.has(name)) return this.results.get(name);
    const result = await callback();
    this.results.set(name, result);
    return result;
  }
}

const EVENT = {
  instanceId: "v9-publication-1788433200",
  timestamp: new Date("2026-09-03T11:00:00.000Z"),
  workflowName: "safety-score-v9-publication",
  payload: {},
} as const;

describe("Safety Score V9 publication Workflow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("uses the cron slot as the deterministic Workflow instance id", () => {
    expect(safetyScoreV9WorkflowInstanceId(1788433200)).toBe(
      "v9-publication-1788433200",
    );
    expect(scheduledInstanceId(1788433200)).toBe(
      safetyScoreV9WorkflowInstanceId(1788433200),
    );
    expect(safetyScoreV9WorkflowSlotStartedAt("v9-publication-1788433200")).toBe(1788433200);
    expect(() => safetyScoreV9WorkflowSlotStartedAt("v9-publication:1788433200")).toThrow(
      "Safety Score V9 Workflow instance id is invalid",
    );
  });

  it("takes the slot from params when the runtime event carries no instance id", async () => {
    // Production instance v9-publication-1788466920 errored before its first
    // step because the runtime event did not expose `instanceId`, so the slot
    // must come from the trigger's `params` payload.
    const step = new ReplayFakeStep();
    const { db } = createWorkflowDb();
    computeSafetyScoreV9.mockImplementation(compileCanonicalPublication);
    const runtimeEvent = {
      timestamp: EVENT.timestamp,
      workflowName: EVENT.workflowName,
      payload: { slotStartedAt: 1788433200 },
    } as unknown as typeof EVENT;

    await expect(
      runSafetyScoreV9PublicationWorkflow({ DB: db }, runtimeEvent, step as unknown as WorkflowStep),
    ).resolves.toMatchObject({
      status: "complete",
      instanceId: "v9-publication-1788433200",
    });
    expect(step.calls[0]?.name).toBe("load fixed input");
  });

  it("replays completed steps without repeating compiler or writer effects", async () => {
    const step = new ReplayFakeStep();
    const { db, sqlite } = createWorkflowDb();
    computeSafetyScoreV9.mockImplementation(compileCanonicalPublication);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const first = await runSafetyScoreV9PublicationWorkflow(
      { DB: db },
      EVENT,
      step as unknown as WorkflowStep,
    );
    const second = await runSafetyScoreV9PublicationWorkflow(
      { DB: db },
      EVENT,
      step as unknown as WorkflowStep,
    );

    expect(first).toEqual(second);
    expect(parseNativeV9InputCacheArtifact).toHaveBeenCalledTimes(1);
    expect(computeSafetyScoreV9).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT key FROM cache ORDER BY key").all()).toEqual([
      { key: "report-cards:fixed-input:exact" },
      { key: "safety-score-v9:shadow:report-cards:v9:1788433200" },
    ]);
    expect(sqlite.prepare("SELECT job, status FROM cron_runs").all()).toEqual([
      { job: SAFETY_SCORE_V9_WORKFLOW_JOB, status: "ok" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(step.calls.slice(0, 4).map(({ name }) => name)).toEqual([
      "load fixed input",
      "compile publication",
      "gate publication",
      "write shadow publication",
    ]);
  });

  it("rejects mixed batches before any live write or capture", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec("INSERT INTO cache VALUES ('live', 'original', 1)");
    for (const query of [
      "INSERT INTO cache (key, value, updated_at) VALUES ('live', 'changed', 2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "DELETE FROM cache WHERE key = 'live'",
      "DELETE FROM cron_runs",
    ]) {
      const capture = createSafetyScoreV9ShadowCaptureDatabase(db);
      await expect(capture.db.batch([
        capture.db.prepare("SELECT value FROM cache"),
        capture.db.prepare(query),
      ])).rejects.toThrow();
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = 'live'").get()).toEqual({ value: "original" });
      expect(capture.state.cacheWrites.size).toBe(0);
    }
    const capture = createSafetyScoreV9ShadowCaptureDatabase(db);
    await expect(capture.db.batch([db.prepare("DELETE FROM cache")])).rejects.toThrow("untracked");
    expect(sqlite.prepare("SELECT value FROM cache").all()).toEqual([{ value: "original" }]);
  });

  it("captures canonical runner cache writes without executing live writes", async () => {
    const baseRun = vi.fn(async () => d1Result(1));
    const baseStatement = {
      bind: () => baseStatement,
      run: baseRun,
      first: async () => null,
      all: async () => d1Result(),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
    const baseDb = {
      prepare: () => baseStatement,
      batch: vi.fn(),
    } as unknown as D1Database;
    const capture = createSafetyScoreV9ShadowCaptureDatabase(baseDb);

    await capture.db.prepare(
      "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
    ).bind("report-cards:v9", "canonical", 1788433200).run();

    expect(baseRun).not.toHaveBeenCalled();
    expect(capture.state.cacheWrites.get("report-cards:v9")).toEqual({
      value: "canonical",
      updatedAt: 1788433200,
    });
    await expect(
      capture.db.prepare("INSERT INTO other_table (value) VALUES (?)")
        .bind("unsafe")
        .run(),
    ).rejects.toThrow("non-cache D1 write");
  });

  it("keeps identical shadow retries durable and rolls back conflicting generations", async () => {
    const { db, sqlite } = fixtures.open();
    const gated = {
      shadowKey: `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:report-cards:v9:1788433200`,
      shadowValue: "shadow-envelope",
      updatedAt: 1788433200,
      cronStatus: "ok" as const,
      itemCount: 200,
      error: null,
      cronMetadata: "{\"publicationStatus\":\"published\"}",
    };
    const write = (value = gated, instanceId = EVENT.instanceId as string) =>
      writeSafetyScoreV9ShadowPublication(db, instanceId, 1788433200, EVENT.timestamp.getTime(), value);
    await write();
    const rows = sqlite.prepare("SELECT * FROM cron_runs").all();
    expect(rows).toMatchObject([{
      job: SAFETY_SCORE_V9_WORKFLOW_JOB, status: "ok", item_count: 200,
      slot_started_at: 1788433200, error: null,
      idempotency_key: `workflow:${SAFETY_SCORE_V9_WORKFLOW_JOB}:${EVENT.instanceId}`,
    }]);
    await write();
    expect(sqlite.prepare("SELECT * FROM cron_runs").all()).toEqual(rows);
    for (const conflict of [{ ...gated, shadowValue: "different" }, { ...gated, updatedAt: gated.updatedAt + 1 }]) {
      await expect(write(conflict, "conflicting-instance")).rejects.toThrow();
      expect(sqlite.prepare("SELECT key, value, updated_at FROM cache").all()).toEqual([{
        key: gated.shadowKey, value: "shadow-envelope", updated_at: 1788433200,
      }]);
      expect(sqlite.prepare("SELECT * FROM cron_runs").all()).toEqual(rows);
    }
  });

  it("records terminal errors without shadow publication for missing, newer or advanced inputs", async () => {
    for (const failure of ["missing", "newer", "advanced"] as const) {
      const { db, sqlite } = createWorkflowDb();
      if (failure === "missing") sqlite.exec("DELETE FROM cache");
      if (failure === "newer") {
        parseNativeV9InputCacheArtifact.mockResolvedValueOnce({
          input: { sourceGeneration: "report-cards:v9:1788433200", baseInputGenerationId: "report-cards-input:v1:1788433200", clockSec: 1788433201 },
        });
      }
      computeSafetyScoreV9.mockImplementation(async (compilerDb: D1Database) => {
        const result = await compileCanonicalPublication(compilerDb);
        return { ...result, metadata: JSON.stringify({
          ...JSON.parse(result.metadata), sourceGenerationId: "report-cards:v9:1788433201",
        }) };
      });
      const result = await runSafetyScoreV9PublicationWorkflow({ DB: db }, EVENT, new ReplayFakeStep() as unknown as WorkflowStep);
      expect(result).toEqual({ instanceId: EVENT.instanceId, shadowKey: null, sourceGeneration: null, status: "error" });
      expect(sqlite.prepare("SELECT key FROM cache WHERE key != 'report-cards:fixed-input:exact'").all()).toEqual([]);
      expect(sqlite.prepare("SELECT status, error FROM cron_runs").all()).toEqual([{
        status: "error", error: expect.stringContaining(failure === "missing" ? "missing" : failure === "newer" ? "newer" : "advanced"),
      }]);
    }
  });

  it("rejects identity mismatches and publication-envelope inconsistencies independently", async () => {
    const fixed = { sourceGeneration: "report-cards:v9:1788433200", baseInputGenerationId: "report-cards-input:v1:1788433200", clockSec: 1788433200 };
    const metadata = { sourceGenerationId: fixed.sourceGeneration, baseInputGenerationId: fixed.baseInputGenerationId, publication: { status: "published" } };
    const compiled = {
      status: "ok" as const, itemCount: 1, metadata: JSON.stringify(metadata), error: null,
      publicationEnvelope: "canonical", publicationHealth: null, publicationAttempt: null,
      failedPublicationAttempt: null, capturedCacheKeys: ["report-cards:v9"],
    };
    await expect(gateSafetyScoreV9ShadowPublication(EVENT.instanceId, fixed.clockSec, fixed, compiled))
      .resolves.toMatchObject({ shadowKey: `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:${fixed.sourceGeneration}` });
    for (const invalid of [
      { ...compiled, metadata: JSON.stringify({ ...metadata, sourceGenerationId: "other" }) },
      { ...compiled, metadata: JSON.stringify({ ...metadata, baseInputGenerationId: "other" }) },
      { ...compiled, publicationEnvelope: null },
      { ...compiled, metadata: JSON.stringify({ ...metadata, publication: { status: "held" } }) },
    ]) {
      await expect(gateSafetyScoreV9ShadowPublication(EVENT.instanceId, fixed.clockSec, fixed, invalid)).rejects.toThrow();
    }
  });

  it("persists held assessment sidecars without inventing a publication", async () => {
    const gated = await gateSafetyScoreV9ShadowPublication(
      EVENT.instanceId,
      1788433200,
      {
        sourceGeneration: "report-cards:v9:1788433200",
        baseInputGenerationId: "report-cards-input:v1:1788433200",
        clockSec: 1788433200,
      },
      {
        status: "degraded",
        itemCount: 0,
        metadata: JSON.stringify({
          sourceGenerationId: "report-cards:v9:1788433200",
          baseInputGenerationId: "report-cards-input:v1:1788433200",
          publication: { status: "held" },
        }),
        error: null,
        publicationEnvelope: null,
        publicationHealth: "held-health",
        publicationAttempt: "held-attempt",
        failedPublicationAttempt: null,
        capturedCacheKeys: [
          "report-cards:v9:last-attempt",
          "report-cards:v9:publication-health",
        ],
      },
    );

    const shadow = JSON.parse(gated.shadowValue) as {
      publicationStatus: string;
      captured: {
        publicationEnvelope: string | null;
        publicationHealth: string | null;
        publicationAttempt: string | null;
      };
    };
    expect(gated.shadowKey).toBe(
      "safety-score-v9:shadow:report-cards:v9:1788433200",
    );
    expect(shadow).toMatchObject({
      publicationStatus: "held",
      captured: {
        publicationEnvelope: null,
        publicationHealth: "held-health",
        publicationAttempt: "held-attempt",
      },
    });
  });
});
