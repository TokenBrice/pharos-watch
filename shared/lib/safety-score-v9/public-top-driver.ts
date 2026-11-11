import type { SafetyScoreV9CurrentCard, SafetyScoreV9EvidenceFreshness } from "../../types/safety-score-v9-public";
import { resolveV9PublicWitnessText, resolveV9PublicWitnessTexts } from "../../types/safety-score-v9-public-witness-texts";
import type { V9MintPosture } from "./control-primitives";
import { readableV9PublicText } from "./public-witness-texts";

export interface SafetyScoreV9TopDriver {
  kind: "cap-bound" | "pillar-bound" | "withheld";
  /** Machine key for the cap, or the weakest pillar when score-bearing. */
  label: string | null;
  /** Binding cap limit or weakest pillar score. */
  value: number | null;
  /** Public explanation of the existing binding cap, weakest pillar, or withholding. */
  reason: string | null;
  evidenceFreshness: SafetyScoreV9EvidenceFreshness;
}


const MINT_HEADLINE_REASONS: Readonly<Record<V9MintPosture, string>> = {
  "none-resolved": "No privileged mint authority is established in the reviewed scope.",
  "bounded-admin": "Privileged mint authority is economically bounded.",
  "partially-bounded-admin": "Privileged mint authority is only partly economically bounded.",
  "concentrated-admin": "Mint authority is concentrated in privileged administrators.",
  "collateral-gated": "Privileged minting is collateral-gated.",
  "unbounded-reconciled": "Mint authority is economically unbounded, with qualifying reconciliation or prudential supervision.",
  "unbounded-governed": "Mint authority is economically unbounded but subject to qualifying delayed governance.",
  "unbounded-veto-guarded": "Mint authority is economically unbounded but subject to a qualifying public minority-veto window.",
  "unbounded-operationally-governed": "Mint authority is economically unbounded; its operational process is reviewed separately.",
  "unbounded-adverse": "Economically effective mint authority is unbounded.",
  compromised: "Mint authority is under an active incident.",
  unknown: "The mint authority posture remains unresolved.",
};

function weakestPillarHeadline(
  card: SafetyScoreV9CurrentCard,
  weakest: NonNullable<SafetyScoreV9CurrentCard["weakestPillar"]>,
): string {
  const scoreLabel = String(Math.round(weakest.score * 10) / 10);
  if (weakest.pillar === "control") {
    const binding = card.breakdowns?.control.components.find((component) =>
      component.binding && component.score === weakest.score);
    if (binding) {
      if (binding.kind === "mint" && Object.prototype.hasOwnProperty.call(MINT_HEADLINE_REASONS, binding.posture)) {
        return MINT_HEADLINE_REASONS[binding.posture as V9MintPosture];
      }
      return `${readableV9PublicText(binding.label)} limits Economic Control to ${scoreLabel}/100.`;
    }
  }
  const reasons = card.pillars[weakest.pillar].reasons;
  // Exit reasons must belong to the credited route, not an unused alternative.
  const primary = weakest.pillar === "exit" ? card.breakdowns?.exit.primaryRoute?.key : null;
  const reason = primary
    ? reasons.find((item) => item.path?.includes(primary))
    : weakest.pillar !== "control" ? reasons[0] : undefined;
  if (reason) return readableV9PublicText(reason.message);
  const label = weakest.pillar === "control" ? "Economic Control" : weakest.pillar === "backing" ? "Backing" : "Exit";
  return `${label} is the weakest pillar at ${scoreLabel}/100.`;
}


/**
 * Projects the existing public card into the one-line driver used by list
 * surfaces. This is deliberately a read-only projection: it does not inspect
 * score inputs or recompute a cap, pillar minimum, or evidence state.
 */
export function projectTopDriver(card: SafetyScoreV9CurrentCard): SafetyScoreV9TopDriver | null {
  if (card.witnessTexts !== undefined) card = resolveV9PublicWitnessTexts(card);
  const evidenceFreshness = card.evidence.freshness;
  if (card.score === null || card.grade === "NR") {
    const message = card.nrReasons[0]?.message ?? "Required evidence is withheld.";
    return {
      kind: "withheld",
      label: null,
      value: null,
      reason: card.witnessTexts === undefined ? message : resolveV9PublicWitnessText(card, message),
      evidenceFreshness,
    };
  }
  if (card.bindingCap !== null) {
    return {
      kind: "cap-bound",
      label: card.bindingCap.kind,
      value: card.bindingCap.limit,
      reason: card.bindingCap.reason,
      evidenceFreshness,
    };
  }
  if (card.weakestPillar !== null) {
    return {
      kind: "pillar-bound",
      label: card.weakestPillar.pillar,
      value: card.weakestPillar.score,
      reason: weakestPillarHeadline(card, card.weakestPillar),
      evidenceFreshness,
    };
  }
  return null;
}
