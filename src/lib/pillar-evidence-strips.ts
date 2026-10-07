import type { BridgeRouteRiskTier, SafetyScoreV9CurrentCard } from "@shared/types";
import { BRIDGE_TIER_LABELS, getBridgeTierLabel, type ControlComponentRole } from "@shared/lib/classification";
import { gradeRange, scoreToGrade } from "@shared/lib/report-card-core";
import { resolveMintAuthorityScoreDisplay, type MintAuthorityScoreFilterValue } from "@/lib/mint-authority-display";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";

/**
 * Economic Control component roles for `/stablecoin/[id]/`: which published
 * Control component is limiting, eligible, diagnostic or excluded, read once
 * from the loaded report card and shared by Mint Authority, the Price feed,
 * Bridging & deployments and the rail Evidence index. Nothing here is
 * re-scored. Tones come from the grade range, the same mapping the score
 * card's pillar rows use, so a module and the card can never disagree.
 */

/** Only the card fields the roles read; full cards satisfy it. */
type ControlRolesCard = Pick<SafetyScoreV9CurrentCard, "pillars" | "breakdowns">;

type ControlBreakdownComponent = NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["control"]["components"][number];

/**
 * Restrained tinting, as on the score card's component rows: a pill leaves
 * neutral only when the input is the problem. Grade ranges A and B stay
 * neutral, C and D warn, F is critical.
 */
export type PillarStripTone = "neutral" | "warn" | "critical";

export interface ControlStripComponent {
  key: string;
  label: string;
  kind: ControlBreakdownComponent["kind"];
  score: number | null;
  /** Raw producer posture slug. */
  posture: string;
  postureLabel: string;
  role: ControlComponentRole;
  tone: PillarStripTone;
}

export interface ControlComponentRoles {
  /** Lowest score in the eligible set; null when the set is empty. */
  minimum: number | null;
  /** The breakdown's pre-adjustment score: the minimum, the neutral score for an empty set, or null when the pillar is excluded (excluded-a-b). */
  evaluatedScore: number | null;
  /** The published pillar score differs from the evaluated baseline at display precision. */
  adjusted: boolean;
  components: ControlStripComponent[];
}

/**
 * The bridge component the producer emits when every reviewed deployment is
 * native issuance (`control.ts`: bridge review not applicable). It scores the
 * `single-chain-or-native` tier and is named after the Bridging module.
 */
const NATIVE_BRIDGE_KEY = "bridge:native";

/**
 * Mint components take the Mint Authority pill's band, not the score's grade
 * range, so a "Hardened 55" never reads as a warning beside a green module pill.
 */
const MINT_BAND_TONES: Record<MintAuthorityScoreFilterValue, PillarStripTone> = {
  hardened: "neutral",
  governed: "neutral",
  managed: "warn",
  concentrated: "warn",
  exposed: "critical",
  nr: "neutral",
};

function scoreTone(score: number | null): PillarStripTone {
  if (score === null) return "neutral";
  const range = gradeRange(scoreToGrade(score));
  if (range === "F") return "critical";
  if (range === "C" || range === "D") return "warn";
  return "neutral";
}

function controlComponentLabel(component: ControlBreakdownComponent): string {
  if (component.kind === "mint") return "Mint authority";
  if (component.kind === "oracle") return "Oracle";
  if (component.key === NATIVE_BRIDGE_KEY) return "Bridging";
  return component.label;
}

function isBridgeTier(posture: string): posture is BridgeRouteRiskTier {
  return Object.hasOwn(BRIDGE_TIER_LABELS, posture);
}

/** Mint reads its published band ("Managed"), as the Mint Authority pill does; bridges read the Bridging module's tier names. */
function controlPostureLabel(component: ControlBreakdownComponent): string {
  if (component.kind === "mint") {
    const display = resolveMintAuthorityScoreDisplay({ score: component.score, posture: component.posture });
    if (display.bandKey !== "nr") return display.bandLabel;
  }
  if (component.kind === "bridge" && isBridgeTier(component.posture)) return getBridgeTierLabel(component.posture, 1);
  return humanizeSafetyScoreV9Value(component.posture);
}

function controlComponentTone(component: ControlBreakdownComponent): PillarStripTone {
  if (component.kind !== "mint") return scoreTone(component.score);
  return MINT_BAND_TONES[resolveMintAuthorityScoreDisplay({ score: component.score, posture: component.posture }).bandKey];
}

/**
 * The Control pillar is a `minimum-binding-component` score: `binding: true`
 * marks membership in the eligible set, and the evaluated score is the minimum
 * over eligible non-null scores, before pillar adjustments. So:
 * - eligible components at that minimum are `limiting` (ties included);
 * - other eligible components are `eligible`;
 * - `binding: false` components are `diagnostic`, even at the minimum;
 * - `score: null` components are `excluded`;
 * - an empty eligible set has no limiting component: the neutral score when
 *   one is published, otherwise (excluded-a-b) the pillar is not scored.
 */
export function resolveControlComponentRoles(card: ControlRolesCard): ControlComponentRoles | null {
  const breakdown = card.breakdowns?.control ?? null;
  if (breakdown === null) return null;
  const eligibleScores = breakdown.components.flatMap((component) =>
    component.binding && component.score !== null ? [component.score] : [],
  );
  const minimum = eligibleScores.length === 0 ? null : Math.min(...eligibleScores);
  const published = card.pillars.control.score;
  const baseline = minimum ?? breakdown.evaluatedScore;
  return {
    minimum,
    evaluatedScore: breakdown.evaluatedScore,
    // Scores print whole, so a sub-point adjustment (81 → 80.98) leaves no
    // visible gap to explain.
    adjusted: published !== null && baseline !== null && Math.round(published) !== Math.round(baseline),
    components: breakdown.components.map((component) => {
      const role: ControlComponentRole = component.score === null
        ? "excluded"
        : !component.binding
          ? "diagnostic"
          : component.score === minimum
            ? "limiting"
            : "eligible";
      return {
        key: component.key,
        label: controlComponentLabel(component),
        kind: component.kind,
        score: component.score,
        posture: component.posture,
        postureLabel: controlPostureLabel(component),
        role,
        tone: controlComponentTone(component),
      };
    }),
  };
}
