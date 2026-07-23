import { describe, expect, it, vi } from "vitest";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import type { ActiveV8SafetyScoreHistorySource } from "../safety-score-history-v2";
import { executeSafetyScoreHistoryBoundaryOperation } from "../safety-score-history-boundary-operation";

const digest = (character: string) => character.repeat(64);
const baseInputGenerationId = `report-cards-input:v1:${digest("a")}`;

function v8Source(): ActiveV8SafetyScoreHistorySource {
  const identity = {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "8.17",
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId,
    publicationGenerationId: "report-cards:8.17:1700000000",
  };
  return {
    identity,
    publishedAtSec: 1_700_000_000,
    snapshot: {
      safetyScoreIdentity: identity,
      cards: [
        { id: "alpha", overallGrade: "A", overallScore: 90, isDefunct: false },
        { id: "gone", overallGrade: "NR", overallScore: null, isDefunct: true },
      ],
    } as ActiveV8SafetyScoreHistorySource["snapshot"],
  };
}

function v9Snapshot(): ReportCardsV9Response {
  const identity = {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "candidate-v9-boundary-test",
    policyId: "safety-score-v9-boundary-test",
    policyDigest: digest("c"),
    evaluationBuildDigest: digest("d"),
    baseInputGenerationId,
    publicationGenerationId: "report-cards:v9:candidate:boundary-test",
  };
  return {
    model: "v9",
    schemaVersion: 1,
    lifecycle: "shadow",
    safetyScoreIdentity: identity,
    methodology: {
      version: identity.methodologyVersion,
      policy: { id: identity.policyId, semanticDigest: identity.policyDigest },
    },
    asOfSec: 1_700_000_000,
    updatedAt: 1_700_000_030,
    completeness: { expectedCount: 1, ratedCount: 1, notRatedCount: 0, notRatedIds: [] },
    source: {
      candidateId: "candidate-v9-boundary-test",
      factSetDigest: digest("e"),
      resultDigest: digest("f"),
      sourceGenerations: {},
    },
    cards: [
      {
        id: "alpha",
        score: 88,
        grade: "A-",
      },
    ],
    dependencyGraph: { edges: [] },
  } as unknown as ReportCardsV9Response;
}

function statementRecorder() {
  const statements: D1PreparedStatement[] = [];
  const db = {
    prepare: vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
      } as unknown as D1PreparedStatement;
      statements.push(statement);
      return statement;
    }),
  } as unknown as D1Database;
  return { db, statements };
}

describe("Safety Score history boundary operation", () => {
  it("writes a V9 activation baseline only for the exact approved identity", async () => {
    const source = v9Snapshot();
    const { db, statements } = statementRecorder();
    const execute = vi.fn(async (_db: D1Database, prepared: D1PreparedStatement[]) => prepared.length);

    const result = await executeSafetyScoreHistoryBoundaryOperation(
      db,
      {
        operation: "activate-v9",
        expectedIdentity: source.safetyScoreIdentity,
        recordedAtSec: 1_700_000_100,
        createdAtSec: 1_700_000_101,
      },
      { loadV9Snapshot: async () => source, execute },
    );

    expect(result).toMatchObject({
      operation: "activate-v9",
      transitionKind: "methodology-boundary-baseline",
      identity: source.safetyScoreIdentity,
      cardCount: 1,
      changes: 1,
    });
    expect(statements).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith(db, statements, undefined);
  });

  it("rejects a cache/source identity change before preparing any history row", async () => {
    const source = v9Snapshot();
    const { db, statements } = statementRecorder();

    await expect(
      executeSafetyScoreHistoryBoundaryOperation(
        db,
        {
          operation: "activate-v9",
          expectedIdentity: { ...source.safetyScoreIdentity, publicationGenerationId: "unexpected-publication" },
          recordedAtSec: 1_700_000_100,
          createdAtSec: 1_700_000_101,
        },
        { loadV9Snapshot: async () => source },
      ),
    ).rejects.toThrow(/does not match the approved identity/);
    expect(statements).toHaveLength(0);
  });

  it("rejects boundary timestamps outside the source-to-operation interval", async () => {
    const source = v9Snapshot();
    const beforeSource = statementRecorder();
    const afterOperation = statementRecorder();

    await expect(
      executeSafetyScoreHistoryBoundaryOperation(
        beforeSource.db,
        {
          operation: "activate-v9",
          expectedIdentity: source.safetyScoreIdentity,
          recordedAtSec: source.updatedAt - 1,
          createdAtSec: source.updatedAt + 10,
        },
        { loadV9Snapshot: async () => source },
      ),
    ).rejects.toThrow(/cannot predate its approved source/);
    await expect(
      executeSafetyScoreHistoryBoundaryOperation(
        afterOperation.db,
        {
          operation: "activate-v9",
          expectedIdentity: source.safetyScoreIdentity,
          recordedAtSec: source.updatedAt + 11,
          createdAtSec: source.updatedAt + 10,
        },
        { loadV9Snapshot: async () => source },
      ),
    ).rejects.toThrow(/cannot postdate its operation/);
    expect(beforeSource.statements).toHaveLength(0);
    expect(afterOperation.statements).toHaveLength(0);
  });

  it("uses distinct non-comparable rollback and restoration transition kinds", async () => {
    const v8 = v8Source();
    const v9 = v9Snapshot();
    const rollback = statementRecorder();
    const restoration = statementRecorder();

    const rollbackResult = await executeSafetyScoreHistoryBoundaryOperation(
      rollback.db,
      {
        operation: "rollback-v8",
        expectedIdentity: v8.identity,
        recordedAtSec: 1_700_000_200,
        createdAtSec: 1_700_000_201,
      },
      { loadV8Source: async () => v8, execute: async (_db, statements) => statements.length },
    );
    const restorationResult = await executeSafetyScoreHistoryBoundaryOperation(
      restoration.db,
      {
        operation: "restore-v9",
        expectedIdentity: v9.safetyScoreIdentity,
        recordedAtSec: 1_700_000_300,
        createdAtSec: 1_700_000_301,
      },
      { loadV9Snapshot: async () => v9, execute: async (_db, statements) => statements.length },
    );

    expect(rollbackResult.transitionKind).toBe("rollback-baseline");
    expect(restorationResult.transitionKind).toBe("restoration-baseline");
    expect(rollbackResult.cardCount).toBe(1);
    expect(restorationResult.cardCount).toBe(1);
  });
});
