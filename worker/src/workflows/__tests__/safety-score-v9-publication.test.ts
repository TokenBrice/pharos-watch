import { beforeEach, describe, expect, it, vi } from "vitest";
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
  writeSafetyScoreV9ShadowPublication,
} from "../safety-score-v9-publication";
import {
  safetyScoreV9WorkflowInstanceId as scheduledInstanceId,
} from "../../handlers/scheduled/v9-publication";

interface BoundStatement {
  sql: string;
  bindings: unknown[];
}

function d1Result(changes = 0): D1Result {
  return {
    success: true,
    meta: { changes },
    results: [],
  } as unknown as D1Result;
}

function createRecordingDb(
  seed: Record<string, { value: string; updatedAt: number }> = {},
) {
  const statements: BoundStatement[] = [];
  const cache = new Map(Object.entries(seed));

  const prepare = (sql: string): D1PreparedStatement => {
    const bindings: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => {
        bindings.splice(0, bindings.length, ...values);
        return statement;
      },
      first: async () => {
        if (sql.includes("SELECT value, updated_at FROM cache")) {
          const row = cache.get(String(bindings[0]));
          return row === undefined
            ? null
            : { value: row.value, updated_at: row.updatedAt };
        }
        return null;
      },
      run: async () => {
        statements.push({ sql, bindings: [...bindings] });
        return d1Result(1);
      },
      all: async () => d1Result(),
      raw: async () => [],
    } as unknown as D1PreparedStatement;
    return statement;
  };

  const db = {
    prepare,
    batch: async (batch: D1PreparedStatement[]) => {
      for (const statement of batch) {
        await statement.run();
        const recorded = statements[statements.length - 1]!;
        if (recorded.sql.includes("INSERT INTO cache")) {
          cache.set(String(recorded.bindings[0]), {
            value: String(recorded.bindings[1]),
            updatedAt: Number(recorded.bindings[2]),
          });
        }
      }
      return batch.map(() => d1Result(1));
    },
  } as unknown as D1Database;
  return { db, statements };
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
  instanceId: "v9-publication:1788433200",
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
      "v9-publication:1788433200",
    );
    expect(scheduledInstanceId(1788433200)).toBe(
      safetyScoreV9WorkflowInstanceId(1788433200),
    );
  });

  it("replays completed steps without repeating compiler or writer effects", async () => {
    const step = new ReplayFakeStep();
    const { db, statements } = createRecordingDb({
      "report-cards:fixed-input:exact": {
        value: "fixed-input-envelope",
        updatedAt: 1788433200,
      },
    });
    computeSafetyScoreV9.mockImplementation(async (compilerDb: D1Database) => {
      for (const [key, value] of [
        ["report-cards:v9", "canonical-publication-envelope"],
        ["report-cards:v9:publication-health", "canonical-health"],
        ["report-cards:v9:last-attempt", "canonical-attempt"],
      ] as const) {
        await compilerDb.prepare(
          "INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)",
        ).bind(key, value, 1788433200).run();
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
    });
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
    expect(statements.filter(({ sql }) =>
      sql.includes("INSERT INTO cache")
    )).toHaveLength(1);
    expect(statements.filter(({ sql }) =>
      sql.includes("INSERT INTO cron_runs")
    )).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(step.calls.slice(0, 4).map(({ name }) => name)).toEqual([
      "load fixed input",
      "compile publication",
      "gate publication",
      "write shadow publication",
    ]);
    for (const { config } of step.calls) {
      expect(config).toMatchObject({
        retries: { limit: 3, backoff: "exponential" },
        timeout: "14 minutes",
      });
    }
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

  it("writes only the generation-scoped shadow key and a compatible terminal row", async () => {
    const { db, statements } = createRecordingDb();
    const shadowKey = `${SAFETY_SCORE_V9_SHADOW_CACHE_PREFIX}:report-cards:v9:1788433200`;
    await writeSafetyScoreV9ShadowPublication(
      db,
      EVENT.instanceId,
      1788433200,
      EVENT.timestamp.getTime(),
      {
        shadowKey,
        shadowValue: "shadow-envelope",
        updatedAt: 1788433200,
        cronStatus: "ok",
        itemCount: 200,
        error: null,
        cronMetadata: "{\"publicationStatus\":\"published\"}",
      },
    );

    const cacheWrite = statements.find(({ sql }) =>
      sql.includes("INSERT INTO cache"),
    );
    expect(cacheWrite?.bindings[0]).toBe(shadowKey);
    expect(statements.some(({ bindings }) =>
      bindings[0] === "report-cards:v9" ||
      bindings[0] === "report-cards:v9:publication-health"
    )).toBe(false);

    const terminal = statements.find(({ sql }) =>
      sql.includes("INSERT INTO cron_runs"),
    );
    expect(terminal?.bindings).toEqual([
      SAFETY_SCORE_V9_WORKFLOW_JOB,
      1788433200,
      expect.any(Number),
      "ok",
      200,
      "{\"publicationStatus\":\"published\"}",
      1788433200,
      null,
      `workflow:${SAFETY_SCORE_V9_WORKFLOW_JOB}:${EVENT.instanceId}`,
    ]);
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
