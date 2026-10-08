import { describe, expect, it } from "vitest";
import { buildSafetyScoreCompactCard } from "../../src/lib/safety-score-v9/publication-journal";
import type { SafetyScoreCompactCard, SafetyScoreJournalIdentity } from "../../src/lib/safety-score-v9/publication-journal";
import { buildSafetyScoreMovementLedger, classifySafetyScoreMovement, renderSafetyScoreMovementMarkdown, type SafetyScoreMovementRow } from "../lib/safety-score-movement-ledger";
import { makeWorkerV9Card } from "../../src/test-helpers/report-cards-v9";

const identityA: SafetyScoreJournalIdentity = { methodologyVersion: "10.12", policyDigest: "a".repeat(64), evaluationBuildDigest: "b".repeat(64) };
const identityB: SafetyScoreJournalIdentity = { methodologyVersion: "10.13", policyDigest: "c".repeat(64), evaluationBuildDigest: "d".repeat(64) };

function row(id: string, generation: string, clock: number, identity: SafetyScoreJournalIdentity, compact: SafetyScoreCompactCard, score: number | null): SafetyScoreMovementRow {
  return {
    generation_id: generation, stablecoin_id: id, published_at: clock,
    methodology_version: identity.methodologyVersion, policy_digest: identity.policyDigest,
    evaluation_build_digest: identity.evaluationBuildDigest,
    score, grade: compact.grade, compact_json: JSON.stringify(compact), input_lineage_json: JSON.stringify({ dexGenerationId: `${generation}-dex` }),
  };
}
function card(score: number, backing: number, exit: number, control: number): SafetyScoreCompactCard {
  const base = buildSafetyScoreCompactCard(makeWorkerV9Card({ id: "usdc-circle", score }));
  return { ...base, score, pillars: {
    backing: { ...base.pillars.backing, score: backing },
    exit: { ...base.pillars.exit, score: exit },
    control: { ...base.pillars.control, score: control },
  } };
}

describe("safety score movement ledger", () => {
  it("classifies data movements by the largest absolute pillar delta and keeps secondary deltas", () => {
    const before = row("usdc-circle", "g1", 100, identityA, card(70, 80, 75, 70), 70);
    const after = row("usdc-circle", "g2", 200, identityA, card(72, 76, 82, 68), 72);
    const movement = classifySafetyScoreMovement(before, after, []);
    expect(movement.classification).toBe("data:exit");
    expect(movement.pillarDeltas.map((delta) => [delta.pillar, delta.delta])).toEqual([["exit", 7], ["backing", -4], ["control", -2]]);
  });

  it("prefers release identity over data, even when pillars also moved", () => {
    const movement = classifySafetyScoreMovement(
      row("usdc-circle", "g1", 100, identityA, card(70, 80, 75, 70), 70),
      row("usdc-circle", "g2", 200, identityB, card(90, 95, 85, 90), 90), []);
    expect(movement.classification).toBe("release");
    expect(movement.previousIdentity.methodologyVersion).toBe("10.12");
    expect(movement.identity.policyDigest).toBe(identityB.policyDigest);
  });

  it("classifies pipeline-gap transitions and unexplained hold-adjacent movement as operational, without inventing a pillar delta", () => {
    const rated = row("usdc-circle", "g1", 100, identityA, card(70, 80, 75, 70), 70);
    const held = classifySafetyScoreMovement(rated, row("usdc-circle", "g2", 200, identityA, { ...card(70, 80, 75, 70) }, 70), ["dex-stale"]);
    expect(held.classification).toBe("operational");
    expect(held.adjacentHoldReasonCodes).toEqual(["dex-stale"]);
    const gap = { ...card(70, 80, 75, 70), ratingStatus: "pipeline-gap" as const, score: null };
    expect(classifySafetyScoreMovement(rated, row("usdc-circle", "g2", 200, identityA, gap, null), []).classification).toBe("operational");
    expect(classifySafetyScoreMovement(row("usdc-circle", "g1", 100, identityA, gap, null), rated, []).classification).toBe("operational");
    const unavailable = { ...card(70, 80, 75, 70), pillars: { ...card(70, 80, 75, 70).pillars, exit: { ...card(70, 80, 75, 70).pillars.exit, score: null } } };
    const unavailableMovement = classifySafetyScoreMovement(rated, row("usdc-circle", "g2", 200, identityA, unavailable, null), []);
    expect(unavailableMovement.classification).toBe("data:exit");
    expect(unavailableMovement.pillarDeltas.find((delta) => delta.pillar === "exit")).toMatchObject({ delta: null, before: 75, after: null });
  });

  it("keeps persistent partial Control evidence as context while attributing included Exit, peg and cap movements", () => {
    const partialEvidence: NonNullable<SafetyScoreCompactCard["partialEvidence"]> = {
      reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["control"], causes: ["A"],
    };
    const beforeCard: SafetyScoreCompactCard = {
      ...card(70, 80, 70, 0), partialEvidence,
      pillars: { ...card(70, 80, 70, 0).pillars, control: { score: null, inclusion: "excluded-a-b", causes: [] } },
    };
    const before = row("usdc-circle", "g1", 100, identityA, beforeCard, 70);
    const exitCard: SafetyScoreCompactCard = {
      ...beforeCard, score: 75,
      pillars: { ...beforeCard.pillars, exit: { ...beforeCard.pillars.exit, score: 80 } },
    };
    const movement = classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA, exitCard, 75), ["dex-stale"]);
    expect(movement.classification).toBe("data:exit");
    expect(movement.pillarDeltas.find((delta) => delta.pillar === "exit")).toMatchObject({ delta: 10, before: 70, after: 80 });
    expect(movement.card.partialEvidence).toEqual(partialEvidence);
    expect(movement.previousCard.partialEvidence).toEqual(partialEvidence);
    expect(movement.card.pillars.control.score).toBeNull();
    expect(movement.previousCard.pillars.control.score).toBeNull();
    expect(movement.adjacentHoldReasonCodes).toEqual(["dex-stale"]);
    expect(classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA,
      { ...beforeCard, score: 65, pegMultiplier: 0.8 }, 65), ["dex-stale"]).classification).toBe("data:peg");
    expect(classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA,
      { ...beforeCard, score: 65, bindingCap: { kind: "active-depeg", reason: "depeg", limit: 65 } }, 65), ["dex-stale"]).classification).toBe("data:cap");
    const full = row("usdc-circle", "g3", 300, identityA, card(80, 80, 80, 80), 80);
    expect(classifySafetyScoreMovement(before, full, []).classification).toBe("operational");
    expect(classifySafetyScoreMovement(full, before, []).classification).toBe("operational");
  });

  it("attributes peg-only and cap-only movements explicitly instead of guessing a pillar", () => {
    const before = row("usdc-circle", "g1", 100, identityA, card(70, 80, 75, 70), 70);
    expect(classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA,
      { ...card(69, 80, 75, 70), pegMultiplier: 0.8 }, 69), []).classification).toBe("data:peg");
    expect(classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA,
      { ...card(65, 80, 75, 70), bindingCap: { kind: "active-depeg", reason: "depeg", limit: 65 } }, 65), []).classification).toBe("data:cap");
    expect(classifySafetyScoreMovement(before, row("usdc-circle", "g2", 200, identityA,
      card(70, 80, 75, 70), 70), []).classification).toBe("data:unattributed");
  });

  it("emits only comparable score/grade movements, links adjacent holds, and reports first-sight censors", () => {
    const rows = [
      row("usdc-circle", "g1", 100, identityA, card(70, 80, 75, 70), 70),
      row("pyusd-paypal", "g1", 100, identityA, card(70, 80, 75, 70), 70),
      row("usdc-circle", "g2", 200, identityA, card(72, 76, 82, 68), 72),
      row("usdc-circle", "g3", 300, identityA, card(72, 76, 82, 68), 72),
      row("pyusd-paypal", "g2", 200, identityA, card(73, 70, 78, 70), 73),
      row("new-coin", "g2", 200, identityA, card(60, 60, 60, 60), 60),
    ];
    const ledger = buildSafetyScoreMovementLedger(rows, [
      { attempt_id: "h1", generation_id: "g1", attempted_at: 90, outcome: "held", hold_reason_codes_json: '["dex-stale"]' },
      { attempt_id: "a1", generation_id: "g1", attempted_at: 100, outcome: "accepted", hold_reason_codes_json: "[]" },
      { attempt_id: "h2", generation_id: "gX", attempted_at: 150, outcome: "held", hold_reason_codes_json: '["redemption-stale","dex-stale"]' },
      { attempt_id: "a2", generation_id: "g2", attempted_at: 200, outcome: "accepted", hold_reason_codes_json: "[]" },
    ], 150, 350);
    expect(ledger.movementCount).toBe(2);
    expect(ledger.movementCountsByClassification).toEqual({ "data:exit": 1, "data:backing": 1 });
    const usdc = ledger.movements.find((movement) => movement.coinId === "usdc-circle")!;
    expect(usdc.previousGenerationId).toBe("g1");
    expect(usdc.adjacentHoldReasonCodes).toEqual(["dex-stale", "redemption-stale"]);
    expect(ledger.missingBaselineCoinIds).toEqual(["new-coin"]);
    const markdown = renderSafetyScoreMovementMarkdown(ledger.movements, ledger.missingBaselineCoinIds);
    expect(markdown).toContain("data:exit");
    expect(markdown).toContain("release = non-comparable identity");
    expect(markdown).toContain("1 (new-coin)");
  });
});
