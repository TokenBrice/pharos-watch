import { ContagionScenarioSchema, type ContagionScenario, type V9ContagionScenarioResult } from "../../types/contagion";
import type { V9FactSetCoreV3, V9FactStatusV2 } from "../../types/safety-score-v9-facts";
import type { V9ValidatedPolicyEnvelope } from "../../types/safety-score-v9";
import { compileV9FactSetV3 } from "./compile";
import { evaluateValidatedV9FactSet, projectV9EffectiveBackingPillarScore, type V9EvaluatedAsset } from "./evaluate-set";

import { projectV9CompactPartialEvidence } from "../../types/safety-score-v9-causes";
import { stableJsonStringifyV1 } from "../stable-json";
export interface V9ContagionInput {
  /** Raw schema-4 compiler core, never a serialized compiled fact set. */
  rawCompileInput: V9FactSetCoreV3;
  policy: V9ValidatedPolicyEnvelope;
  clock: number;
  publicationGenerationId: string;
}

/** A full production-engine rerun. No hypothetical facts or cards escape this boundary. */
export function evaluateV9ContagionScenario(input: V9ContagionInput, definition: ContagionScenario): V9ContagionScenarioResult {
  const scenario = ContagionScenarioSchema.parse(definition);
  if (!input.publicationGenerationId || input.clock !== input.rawCompileInput.asOfSec) {
    throw new Error("Contagion requires a publication identity and its exact evaluation clock");
  }
  const dimensions = (asset: V9EvaluatedAsset) => ({ final: asset.trace.finalScore, backing: projectV9EffectiveBackingPillarScore(asset), exit: asset.scoreInput.pillars.exit.score, control: asset.scoreInput.pillars.control.score });
  for (const shock of scenario.shocks) {
    if (!input.rawCompileInput.activeAssetIds.includes(shock.assetId)) throw new Error(`Unknown scenario root: ${shock.assetId}`);
  }
  // Release full baseline traces/facts before constructing the hypothetical set.
  const baseline = (() => {
    const result = evaluateValidatedV9FactSet(compileV9FactSetV3(input.rawCompileInput), input.policy);
    return {
      policyDigest: result.policyDigest, evaluationBuildDigest: result.evaluationBuildDigest,
      factSetDigest: result.factSetDigest,
      assets: result.assets.map((asset) => ({
        assetId: asset.assetId, score: asset.trace.finalScore,
        grade: asset.trace.finalGrade, dimensions: dimensions(asset),
        ratingStatus: asset.trace.ratingStatus,
        partialEvidence: projectV9CompactPartialEvidence(asset.trace.partialEvidence),
      })),
    };
  })();
  // Break interned aliases within and across assets before mutations. Clone one
  // JSON DTO at a time so the full registry's serialized text never overlaps
  // the decoded hypothetical graph (structuredClone would preserve aliases).
  const { assets, ...envelope } = input.rawCompileInput;
  const raw: V9FactSetCoreV3 = {
    ...JSON.parse(JSON.stringify(envelope)),
    assets: assets.map((asset) => JSON.parse(JSON.stringify(asset))),
  };
  for (const shock of scenario.shocks) {
    const asset = raw.assets.find((row) => row.assetId === shock.assetId)!;
    if (shock.kind === "score-limit") continue;
    const evidenceId = `hypothetical:${scenario.id}:${shock.assetId}:${shock.kind}`;
    // Published here means a published scenario assumption, not an observed event.
    // These ephemeral facts are never returned or passed to publication/journal code.
    if (!asset.evidence.some((row) => row.evidenceId === evidenceId)) asset.evidence.push({
      evidenceId, sourceId: "hypothetical-scenario-assumption", sourceGenerationId: scenario.id,
      disposition: "published", observedAtSec: input.clock, publishedAtSec: input.clock,
      url: null, contentSha256: null, freshness: { state: "not-assessed", ageSec: 0, maxAgeSec: null }, rejection: null,
    });
    const status: V9FactStatusV2 = {
      applicability: { state: "required", policyRuleId: "hypothetical-scenario", rationale: null, gapId: null },
      observationState: "known", evidenceRefIds: [evidenceId], gapIds: [],
    };
    const assumedStatus = (prior: V9FactStatusV2): V9FactStatusV2 => ({
      ...status, evidenceRefIds: [...new Set([...prior.evidenceRefIds, evidenceId])],
    });
    if (shock.kind === "depeg") {
      // Template duration describes the assumed event horizon; historical peg
      // performance and all exit facts are explicitly held at capture values.
      const pegStatus = asset.peg.pegScore === null
        ? { ...asset.peg.status, evidenceRefIds: [...new Set([...asset.peg.status.evidenceRefIds, evidenceId])] }
        : assumedStatus(asset.peg.status);
      asset.peg = { ...asset.peg, status: pegStatus, activeDepeg: true, activeDepegBps: shock.activeDepegBps, currentDeviationBps: shock.activeDepegBps };
    } else {
      const key = asset.economicControlReview.mint.controlKey ?? `hypothetical-mint:${asset.assetId}`;
      const existing = asset.controls.find((row) => row.controlKey === key);
      if (existing) {
        existing.incidentState = "active";
        existing.status = assumedStatus(existing.status);
      } else {
        asset.controls.push({
          controlKey: key, deploymentKey: `hypothetical:${asset.assetId}`, sourceGenerationId: raw.sourceFingerprints.researchOverlays.generationId,
          controlKind: "mint", scope: "global", status, capabilities: ["mint"],
          capSemantics: { kind: "unbounded", bound: null }, claimImpairment: "unbounded", economicLossScope: "global-claim",
          authority: { authorityKey: `hypothetical:${asset.assetId}`, model: "eoa", threshold: null },
          delaySec: 0, materialSupplyShare: 1, keyCustody: "unknown", modulesOrGuards: "none-detected", incidentState: "active",
          failureDomains: [{ kind: "mint-control", key: `hypothetical:${asset.assetId}` }],
        });
      }
      asset.economicControlReview.mint = { ...asset.economicControlReview.mint, status: assumedStatus(asset.economicControlReview.mint.status), controlKey: key, reconciliation: "none", supervision: "none" };
      asset.controlStatus = assumedStatus(asset.controlStatus);
    }
    // Replacing an unknown fact with an explicit assumption retires only gaps
    // no longer referenced anywhere in that asset's remaining facts.
    const references = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === "string") references.add(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(collect);
    };
    const { gaps, ...remainingFacts } = asset;
    collect(remainingFacts);
    asset.gaps = gaps.filter((gap) => references.has(gap.gapId));
  }
  const failures = new Map<string, string>();
  const evaluated = evaluateValidatedV9FactSet(compileV9FactSetV3(raw), input.policy, {
    projectUpstream(result) {
      let projected = result;
      for (const shock of scenario.shocks) {
        if (shock.kind !== "score-limit" || shock.assetId !== result.assetId) continue;
        const key = shock.dimension === "final" ? "score" : "backingScore";
        const value = projected[key];
        projected = { ...projected, [key]: value === null ? null : Math.min(value, shock.limit) };
      }
      return projected;
    },
    projectEvaluatedUpstream(result) {
      let score = projectV9EffectiveBackingPillarScore(result);
      for (const shock of scenario.shocks) {
        if (shock.kind === "score-limit" && shock.dimension === "backing" && shock.assetId === result.assetId && score !== null) {
          score = Math.min(score, shock.limit);
        }
      }
      if (score === projectV9EffectiveBackingPillarScore(result)) return result;
      return { ...result, scoreInput: { ...result.scoreInput, pillars: {
        ...result.scoreInput.pillars, backing: { ...result.scoreInput.pillars.backing, score },
      } } };
    },
    onAssetError: (id, error) => failures.set(id, error instanceof Error ? error.message : String(error)),
  });
  const after = new Map(evaluated.assets.map((asset) => [asset.assetId, asset]));
  const hops = new Map<string, number>();
  const queue = [...new Set(scenario.shocks.map((shock) => shock.assetId))];
  for (const root of queue) hops.set(root, 0);
  for (let index = 0; index < queue.length; index++) {
    const root = queue[index]!;
    for (const asset of input.rawCompileInput.assets) {
      if (!hops.has(asset.assetId) && asset.dependencies.edges.some((edge) => edge.upstreamAssetId === root)) {
        hops.set(asset.assetId, hops.get(root)! + 1);
        queue.push(asset.assetId);
      }
    }
  }
  const rows = baseline.assets.map((before) => {
    const current = after.get(before.assetId);
    const old = before.dimensions;
    const next = current ? dimensions(current) : null;
    const changedDimensions = (Object.keys(old) as Array<keyof typeof old>).filter((key) => next === null || old[key] !== next[key]);
    const partialEvidence = projectV9CompactPartialEvidence(current?.trace.partialEvidence ?? null);
    if (!changedDimensions.includes("final") && (
      before.ratingStatus !== current?.trace.ratingStatus ||
      stableJsonStringifyV1(before.partialEvidence) !== stableJsonStringifyV1(partialEvidence)
    )) changedDimensions.unshift("final");
    const score = current?.trace.finalScore ?? null;
    return {
      coinId: before.assetId, baselineScore: before.score, baselineGrade: before.grade,
      baselineRatingStatus: before.ratingStatus, baselinePartialEvidence: before.partialEvidence,
      scenarioScore: score, scenarioGrade: current ? current.trace.finalGrade : null,
      scenarioRatingStatus: current?.trace.ratingStatus ?? null,
      scenarioPartialEvidence: partialEvidence,
      delta: score === null || before.score === null ? null : score - before.score,
      shortestHop: hops.get(before.assetId) ?? null, changedDimensions,
      bindingCause: failures.get(before.assetId) ?? current?.trace.bindingCap?.kind ?? null,
      nr: current?.trace.ratingStatus === "not-rated", failure: failures.get(before.assetId) ?? null,
    };
  });
  return {
    schemaVersion: 1, hypothetical: true, provenance: { origin: "scenario-assumptions", scenario },
    identity: { publicationGenerationId: input.publicationGenerationId, policyDigest: baseline.policyDigest, evaluationBuildDigest: baseline.evaluationBuildDigest, factSetDigest: baseline.factSetDigest, asOfSec: input.clock },
    manifest: { evaluated: evaluated.assets.length, unchanged: rows.filter((row) => !row.failure && row.changedDimensions.length === 0).length, nr: rows.filter((row) => row.nr && !row.failure).length, pipelineGap: rows.filter((row) => row.scenarioRatingStatus === "pipeline-gap" && !row.failure).length, failed: failures.size }, rows,
  };
}
