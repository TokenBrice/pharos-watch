import { FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import type { ReportCardGrade } from "@shared/types/report-cards";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import type { ReportCardsV9Response } from "@shared/types/report-cards-v9";
import { throwIfAborted } from "./abort";
import { batchExecute } from "./db";
import { loadPublishedReportCardsV9Snapshot } from "./report-cards-v9-cache";
import {
  loadActiveV8SafetyScoreHistorySource,
  prepareSafetyScoreHistoryBoundaryWrites,
  safetyScoreHistoryIdentitiesMatch,
  type ActiveV8SafetyScoreHistorySource,
  type SafetyScoreHistoryBoundaryCard,
  type SafetyScoreHistoryV2TransitionKind,
} from "./safety-score-history-v2";

export type SafetyScoreHistoryBoundaryOperationKind = "activate-v9" | "rollback-v8" | "restore-v9";

type BoundaryTransitionKind = Extract<
  SafetyScoreHistoryV2TransitionKind,
  "methodology-boundary-baseline" | "rollback-baseline" | "restoration-baseline"
>;

export interface SafetyScoreHistoryBoundaryOperationInput {
  operation: SafetyScoreHistoryBoundaryOperationKind;
  /** Exact release identity approved for this bounded cutover action. */
  expectedIdentity: SafetyScorePublicationIdentity;
  recordedAtSec: number;
  createdAtSec: number;
  signal?: AbortSignal;
}

export interface SafetyScoreHistoryBoundaryOperationResult {
  operation: SafetyScoreHistoryBoundaryOperationKind;
  transitionKind: BoundaryTransitionKind;
  identity: SafetyScorePublicationIdentity;
  recordedAtSec: number;
  cardCount: number;
  changes: number;
}

export interface SafetyScoreHistoryBoundaryOperationDependencies {
  loadV8Source?: (db: D1Database, signal?: AbortSignal) => Promise<ActiveV8SafetyScoreHistorySource>;
  loadV9Snapshot?: (db: D1Database, signal?: AbortSignal) => Promise<ReportCardsV9Response>;
  execute?: (db: D1Database, statements: D1PreparedStatement[], signal?: AbortSignal) => Promise<number>;
}

interface BoundarySource {
  identity: SafetyScorePublicationIdentity;
  cards: SafetyScoreHistoryBoundaryCard[];
}

function assertUnixSeconds(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be non-negative epoch seconds`);
  }
}

function transitionFor(operation: SafetyScoreHistoryBoundaryOperationKind): BoundaryTransitionKind {
  switch (operation) {
    case "activate-v9":
      return "methodology-boundary-baseline";
    case "rollback-v8":
      return "rollback-baseline";
    case "restore-v9":
      return "restoration-baseline";
  }
}

function expectedModel(operation: SafetyScoreHistoryBoundaryOperationKind): SafetyScorePublicationIdentity["model"] {
  return operation === "rollback-v8" ? "v8" : "v9";
}

function sortAndValidateCards(cards: readonly SafetyScoreHistoryBoundaryCard[]): SafetyScoreHistoryBoundaryCard[] {
  const seen = new Set<string>();
  const normalized = cards
    .map((card) => ({
      stablecoinId: card.stablecoinId,
      grade: card.grade as ReportCardGrade,
      score: card.score,
    }))
    .sort((left, right) => left.stablecoinId.localeCompare(right.stablecoinId));
  for (const card of normalized) {
    if (!card.stablecoinId) throw new Error("Safety Score history boundary contains an empty stablecoin ID");
    if (seen.has(card.stablecoinId)) throw new Error(`Duplicate Safety Score history boundary card: ${card.stablecoinId}`);
    seen.add(card.stablecoinId);
  }
  if (normalized.length === 0) throw new Error("Safety Score history boundary source has no eligible cards");
  return normalized;
}

async function loadBoundarySource(
  db: D1Database,
  operation: SafetyScoreHistoryBoundaryOperationKind,
  signal: AbortSignal | undefined,
  dependencies: SafetyScoreHistoryBoundaryOperationDependencies,
): Promise<BoundarySource> {
  if (expectedModel(operation) === "v8") {
    const source = await (dependencies.loadV8Source ?? loadActiveV8SafetyScoreHistorySource)(db, signal);
    return {
      identity: source.identity,
      cards: sortAndValidateCards(
        source.snapshot.cards
          .filter((card) => card.isDefunct !== true && !FROZEN_IDS.has(card.id))
          .map((card) => ({ stablecoinId: card.id, grade: card.overallGrade, score: card.overallScore })),
      ),
    };
  }

  const snapshot = await (dependencies.loadV9Snapshot ?? loadPublishedReportCardsV9Snapshot)(db, signal);
  return {
    identity: snapshot.safetyScoreIdentity,
    cards: sortAndValidateCards(
      snapshot.cards
        .filter((card) => !FROZEN_IDS.has(card.id))
        .map((card) => ({ stablecoinId: card.id, grade: card.grade, score: card.score })),
    ),
  };
}

/**
 * Writes the pre-approved model-cutover baseline and nothing else. It is not
 * routed or scheduled: deployment/runbook code must supply the exact expected
 * identity, so a changed cache cannot silently create a history boundary.
 */
export async function executeSafetyScoreHistoryBoundaryOperation(
  db: D1Database,
  input: SafetyScoreHistoryBoundaryOperationInput,
  dependencies: SafetyScoreHistoryBoundaryOperationDependencies = {},
): Promise<SafetyScoreHistoryBoundaryOperationResult> {
  assertUnixSeconds(input.recordedAtSec, "Safety Score history boundary recordedAtSec");
  assertUnixSeconds(input.createdAtSec, "Safety Score history boundary createdAtSec");
  throwIfAborted(input.signal);

  const expectedIdentity = SafetyScorePublicationIdentitySchema.parse(input.expectedIdentity);
  const expected = expectedModel(input.operation);
  if (expectedIdentity.model !== expected) {
    throw new Error(`Safety Score ${input.operation} boundary requires an expected ${expected.toUpperCase()} identity`);
  }

  const source = await loadBoundarySource(db, input.operation, input.signal, dependencies);
  throwIfAborted(input.signal);
  if (!safetyScoreHistoryIdentitiesMatch(expectedIdentity, source.identity)) {
    throw new Error(`Safety Score ${input.operation} boundary source identity does not match the approved identity`);
  }

  const transitionKind = transitionFor(input.operation);
  const statements = prepareSafetyScoreHistoryBoundaryWrites(db, {
    cards: source.cards,
    recordedAt: input.recordedAtSec,
    transitionKind,
    identity: source.identity,
    createdAt: input.createdAtSec,
  });
  const execute = dependencies.execute ?? ((database, prepared, signal) => batchExecute(database, prepared, { signal }));
  const changes = await execute(db, statements, input.signal);

  return {
    operation: input.operation,
    transitionKind,
    identity: source.identity,
    recordedAtSec: input.recordedAtSec,
    cardCount: source.cards.length,
    changes,
  };
}
