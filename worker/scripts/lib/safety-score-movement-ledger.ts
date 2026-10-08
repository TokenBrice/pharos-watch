import type { SafetyScoreCompactCard, SafetyScoreJournalIdentity } from "../../src/lib/safety-score-v9/publication-journal";

export interface SafetyScoreMovementRow {
  generation_id: string;
  stablecoin_id: string;
  published_at: number;
  methodology_version: string;
  policy_digest: string;
  evaluation_build_digest: string;
  score: number | null;
  grade: SafetyScoreCompactCard["grade"];
  compact_json: string;
  input_lineage_json: string;
}
export interface SafetyScoreMovementAttempt {
  attempt_id: string;
  generation_id: string;
  attempted_at: number;
  outcome: "accepted" | "held";
  hold_reason_codes_json: string;
}
export interface SafetyScoreMovement {
  coinId: string;
  generationId: string;
  previousGenerationId: string;
  publishedAt: number;
  score: number | null;
  previousScore: number | null;
  grade: SafetyScoreCompactCard["grade"];
  previousGrade: SafetyScoreCompactCard["grade"];
  classification: string;
  pillarDeltas: { pillar: "backing" | "exit" | "control"; delta: number | null; before: number | null; after: number | null }[];
  adjacentHoldReasonCodes: string[];
  identity: SafetyScoreJournalIdentity;
  previousIdentity: SafetyScoreJournalIdentity;
  card: SafetyScoreCompactCard;
  previousCard: SafetyScoreCompactCard;
  inputLineage: unknown;
  previousInputLineage: unknown;
}

/** Attribution labels describe retained evidence, not same-input counterfactual causation. */
export function classifySafetyScoreMovement(previous: SafetyScoreMovementRow, current: SafetyScoreMovementRow, holds: readonly string[]): SafetyScoreMovement {
  const before = JSON.parse(previous.compact_json) as SafetyScoreCompactCard;
  const after = JSON.parse(current.compact_json) as SafetyScoreCompactCard;
  const pillarDeltas = (["backing", "exit", "control"] as const).map((pillar) => ({
    pillar, before: before.pillars[pillar].score, after: after.pillars[pillar].score,
    delta: before.pillars[pillar].score === null || after.pillars[pillar].score === null ? null
      : after.pillars[pillar].score! - before.pillars[pillar].score!,
  })).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  const identity = { methodologyVersion: current.methodology_version, policyDigest: current.policy_digest, evaluationBuildDigest: current.evaluation_build_digest };
  const previousIdentity = { methodologyVersion: previous.methodology_version, policyDigest: previous.policy_digest, evaluationBuildDigest: previous.evaluation_build_digest };
  const release = identity.methodologyVersion !== previousIdentity.methodologyVersion ||
    identity.policyDigest !== previousIdentity.policyDigest || identity.evaluationBuildDigest !== previousIdentity.evaluationBuildDigest;
  // Persistent partial-evidence context is not an operational transition.
  // Preserve both endpoints in JSON, but only a change in their operational
  // state can take precedence over an included-pillar, peg or cap movement.
  const operationalTransition = (before.ratingStatus === "pipeline-gap") !== (after.ratingStatus === "pipeline-gap") ||
    JSON.stringify(before.partialEvidence) !== JSON.stringify(after.partialEvidence) ||
    JSON.stringify(before.reasonCodes.filter((code) => code.includes("pipeline-gap"))) !==
      JSON.stringify(after.reasonCodes.filter((code) => code.includes("pipeline-gap")));
  // A pillar availability flip (null on exactly one side) is that pillar's own
  // data change; it is never reported as another pillar's delta or as zero.
  const primary = pillarDeltas.find((delta) =>
    (delta.before === null) !== (delta.after === null) || (delta.delta !== null && delta.delta !== 0));
  const classification = release ? "release"
    : operationalTransition ? "operational"
    : primary ? `data:${primary.pillar}`
    : before.pegMultiplier !== after.pegMultiplier ? "data:peg"
    : JSON.stringify(before.bindingCap) !== JSON.stringify(after.bindingCap) ? "data:cap"
    : holds.length > 0 ? "operational" : "data:unattributed";
  return {
    coinId: current.stablecoin_id, generationId: current.generation_id, previousGenerationId: previous.generation_id,
    publishedAt: current.published_at, score: current.score, previousScore: previous.score,
    grade: current.grade, previousGrade: previous.grade, classification, pillarDeltas,
    adjacentHoldReasonCodes: [...new Set(holds)].sort(), identity, previousIdentity,
    card: after, previousCard: before,
    inputLineage: JSON.parse(current.input_lineage_json), previousInputLineage: JSON.parse(previous.input_lineage_json),
  };
}

export function buildSafetyScoreMovementLedger(rows: readonly SafetyScoreMovementRow[], attempts: readonly SafetyScoreMovementAttempt[], from: number, to: number) {
  const orderedAttempts = [...attempts].sort((a, b) => a.attempted_at - b.attempted_at || (a.attempt_id < b.attempt_id ? -1 : a.attempt_id > b.attempt_id ? 1 : 0));
  const holdsByGeneration = new Map<string, string[]>();
  for (let i = 0; i < orderedAttempts.length; i++) {
    const attempt = orderedAttempts[i]!;
    if (attempt.outcome !== "accepted") continue;
    const adjacent = [orderedAttempts[i - 1], orderedAttempts[i + 1]].filter((row) => row?.outcome === "held");
    holdsByGeneration.set(attempt.generation_id, adjacent.flatMap((row) => JSON.parse(row!.hold_reason_codes_json) as string[]));
  }
  const prior = new Map<string, SafetyScoreMovementRow>();
  const movements: SafetyScoreMovement[] = [];
  const missingBaselineCoinIds: string[] = [];
  const ordered = [...rows].sort((a, b) => a.published_at - b.published_at || (a.generation_id < b.generation_id ? -1 : a.generation_id > b.generation_id ? 1 : 0));
  for (const row of ordered) {
    const previous = prior.get(row.stablecoin_id);
    if (row.published_at >= from && row.published_at < to) {
      if (previous === undefined) missingBaselineCoinIds.push(row.stablecoin_id);
      else if (previous.score !== row.score || previous.grade !== row.grade) {
        movements.push(classifySafetyScoreMovement(previous, row, holdsByGeneration.get(row.generation_id) ?? []));
      }
    }
    prior.set(row.stablecoin_id, row);
  }
  const movementCountsByClassification = movements.reduce<Record<string, number>>((counts, movement) => {
    counts[movement.classification] = (counts[movement.classification] ?? 0) + 1;
    return counts;
  }, {});
  const sortedMovements = [...movements].sort((a, b) => a.publishedAt - b.publishedAt || (a.coinId < b.coinId ? -1 : a.coinId > b.coinId ? 1 : 0));
  return { from, to, movementCount: movements.length, movementCountsByClassification,
    movements: sortedMovements, missingBaselineCoinIds: [...new Set(missingBaselineCoinIds)].sort() };
}

export function renderSafetyScoreMovementMarkdown(movements: readonly SafetyScoreMovement[], missingBaselineCoinIds: readonly string[]): string {
  const cell = (value: unknown) => String(value ?? "unavailable").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    "# Safety Score movement ledger", "",
    "Labels describe evidence: release = non-comparable identity (not proof of release-only causation); data pillar = largest observed absolute pillar delta; operational = changed partial-evidence/pipeline-gap state or unexplained movement adjacent to a hold. Persistent partial evidence and hold adjacency remain context, not an override of included-pillar, peg or cap changes. Secondary deltas and both endpoints remain in JSON. Peg/cap-only movements and unattributed edges are explicit, never fabricated pillar deltas.", "",
    `Missing prior retained baseline: ${missingBaselineCoinIds.length} (${missingBaselineCoinIds.join(", ") || "none"}). First sight is not counted as a movement.`, "",
    "| UTC | Coin | Score | Grade | Classification | Pillar deltas | Hold reasons | Generation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...movements.map((row) => `| ${new Date(row.publishedAt * 1000).toISOString()} | ${cell(row.coinId)} | ${cell(row.previousScore)} → ${cell(row.score)} | ${cell(row.previousGrade)} → ${cell(row.grade)} | ${cell(row.classification)} | ${cell(row.pillarDeltas.map((delta) => `${delta.pillar}:${delta.delta === null ? "unavailable" : delta.delta}`).join(", "))} | ${cell(row.adjacentHoldReasonCodes.join(", ") || "none")} | ${cell(row.generationId)} |`), "",
  ].join("\n");
}
