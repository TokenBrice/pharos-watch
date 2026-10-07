import type { BridgeRouteRiskTier, ReportCardGrade, SafetyScoreV9CurrentCard } from "@shared/types";
import type { ExitRouteFamily } from "@shared/types/exit-route";
import {
  BRIDGE_TIER_LABELS,
  BRIDGE_TIER_POLICY_ORDER,
  getBridgeTierLabel,
  type ControlComponentRole,
} from "@shared/lib/classification";
import { gradeRange, scoreToGrade } from "@shared/lib/report-card-core";
import { resolveV9EffectiveScoringWeight } from "@shared/types/safety-score-v9-public-causes";
import { resolveMintAuthorityScoreDisplay, type MintAuthorityScoreFilterValue } from "@/lib/mint-authority-display";
import { describeExitRouteVenue } from "@/lib/safety-score-reason-labels";
import type { BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation-helpers";

/**
 * View models for the pillar header strips on `/stablecoin/[id]/`: each
 * Safety Score pillar's published decomposition, drawn above the evidence
 * modules that substantiate it. Everything here is read from the loaded
 * report card; nothing is re-scored. Grades come from `scoreToGrade` and bar
 * tones from the grade range, the same mapping the score card's pillar rows
 * use, so a strip and the card can never disagree.
 */

/** Only the card fields a strip reads; full cards satisfy it. */
export type PillarStripCard = Pick<SafetyScoreV9CurrentCard, "pillars" | "breakdowns">;

/**
 * The Bridging tile's route inventory (`coin.bridgeRouteRiskSummary`), so a
 * bridge row reads in the tile's tier vocabulary: "Issuer burn & mint" on
 * MAI's 15 chains, never "Single-chain" on a multi-chain coin.
 */
export type PillarStripBridging = Pick<BridgeRouteRiskClientSummary, "chainCount" | "tierCounts" | "unresolvedRouteCount">;

type Breakdowns = NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>;
type ControlBreakdownComponent = Breakdowns["control"]["components"][number];
type ControlAdjustmentKind = Breakdowns["control"]["adjustments"][number]["kind"];
type ExitBreakdown = Breakdowns["exit"];

/**
 * Restrained tinting, as on the score card's component rows: a bar leaves
 * neutral only when the input is the problem. Grade ranges A and B stay
 * neutral, C and D warn, F is critical.
 */
export type PillarStripTone = "neutral" | "warn" | "critical";

export interface PillarStripHeadline {
  /** Published pillar score; null when the pillar is excluded from the aggregate. */
  score: number | null;
  /** Null exactly when `score` is null; never an invented "F" for missing data. */
  grade: ReportCardGrade | null;
  excluded: boolean;
}

export interface BackingStripGroup {
  key: "reserves" | "mechanism";
  label: string;
  score: number | null;
  /** Share of the Backing pillar (effective scoring weight, 0–1). */
  weight: number;
  tone: PillarStripTone;
}

/**
 * `unverified`: the producer bounded the component instead of observing it
 * (`bounded-unknown`, `missing`, `unsupported`); its score is a bounded
 * placeholder, drawn hatched. `stale`: observed, but past its freshness budget.
 */
export type MechanismComponentState = "known" | "unverified" | "stale";

export interface BackingStripMechanismComponent {
  key: string;
  label: string;
  score: number | null;
  state: MechanismComponentState;
  tone: PillarStripTone;
}

export interface BackingStripView extends PillarStripHeadline {
  pillar: "backing";
  groups: BackingStripGroup[];
  /** Published `source: "mechanism"` component scores, not per-dimension ratings. */
  mechanism: BackingStripMechanismComponent[];
}

export interface ExitStripRoute {
  /** Reader venue ("Uniswap V4 on Ethereum"), never the internal "AMM 6" ordinal. */
  label: string;
  family: ExitRouteFamily;
  score: number | null;
}

export interface ExitStripCapacity {
  executableUsd: number;
  requestedNotionalUsd: number;
  maxCostBps: number;
  /** executable ÷ requested, clamped to 0–1. */
  completionRatio: number;
  /**
   * The route fills the stress request: completion that displays as 100 %
   * and no published `insufficient-completion` cap. The label, the
   * displayed percent and the tone all read this one flag.
   */
  qualified: boolean;
  /** Neutral when qualified; warn below the request; critical when it clears nothing. */
  tone: PillarStripTone;
}

export interface ExitStripExcludedRoute {
  key: string;
  label: string;
  /** The route's own score when the producer published one; it was still not counted. */
  score: number | null;
  reason: string;
}

export interface ExitStripView extends PillarStripHeadline {
  pillar: "exit";
  /** The selected primary route; null when no evaluated route qualified. */
  route: ExitStripRoute | null;
  /** Diversification credit that lifts the pillar above the route score. */
  backup: { label: string; bonus: number } | null;
  /** Null when the selected route carries no capacity measurement. */
  capacity: ExitStripCapacity | null;
  /** The published stress request, so an absent route still names what was asked. */
  stressRequest: { requestedNotionalUsd: number; maxCostBps: number } | null;
  /** Evaluated routes the pillar did not credit, with the published reason. Only filled when `route` is null. */
  excludedRoutes: ExitStripExcludedRoute[];
}

export type ControlComponentKind = ControlBreakdownComponent["kind"];

export interface ControlStripComponent {
  key: string;
  label: string;
  kind: ControlComponentKind;
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
 * Two or more components of one kind and role drawn as one row. Bridges group
 * by role alone (their posture is the tier, which the score range already
 * tells); every other kind also splits by posture, so a row never mixes the
 * band it prints.
 */
export interface ControlStripComponentGroup {
  key: string;
  kind: ControlComponentKind;
  role: ControlComponentRole;
  count: number;
  /** What the count counts ("bridge controls", "deployment mint paths"), never "routes". */
  noun: string;
  /** The shared posture; null for bridge groups. */
  postureLabel: string | null;
  minScore: number | null;
  maxScore: number | null;
  tone: PillarStripTone;
}

/**
 * A Control-pillar adjustment, named. `unresolved-deployment-share` prices
 * bridged supply the card could not resolve into bridge components.
 */
export interface ControlStripAdjustment {
  kind: ControlAdjustmentKind;
  label: string;
  delta: number;
}

export type ControlStripRow =
  | {
      type: "component";
      component: ControlStripComponent;
      /** Tells two rows of one label apart ("token-wide", "deployments"); null when the label is unique. */
      scope: string | null;
    }
  | { type: "group"; group: ControlStripComponentGroup }
  /**
   * Bridged deployments the card prices only through the
   * `unresolved-deployment-share` adjustment, with no bridge component to
   * draw: an unscored row, so the strip states them instead of omitting them.
   */
  | { type: "unresolved-bridges"; delta: number };

export interface ControlStripView extends PillarStripHeadline, Omit<ControlComponentRoles, "components"> {
  pillar: "control";
  /** Eligible rows (lowest first), then diagnostics, then excluded components, then unresolved bridges. */
  rows: ControlStripRow[];
  /** Published pillar adjustments between the evaluated minimum and the pillar score. */
  adjustments: ControlStripAdjustment[];
}

export interface PillarEvidenceStrips {
  backing: BackingStripView | null;
  exit: ExitStripView | null;
  control: ControlStripView | null;
}

/** Fewer than this many components sharing a group key stay individual rows. */
const MIN_GROUP = 2;

/** Producer key prefix of a deployment-scoped mint path (`control.ts`: `mint:deployment:<controlKeys>`). */
const MINT_DEPLOYMENT_KEY_PREFIX = "mint:deployment:";

/**
 * The bridge component the producer emits when every reviewed deployment is
 * native issuance (`control.ts`: bridge review not applicable). It scores the
 * `single-chain-or-native` tier, but its routes can span many chains and
 * carry issuer burn & mint, so it is named from the Bridging tile.
 */
const NATIVE_BRIDGE_KEY = "bridge:native";

/**
 * Mint rows take the Mint Authority pill's band, not the score's grade range,
 * so a "Hardened 55" never draws as a warning beside a green module pill.
 */
const MINT_BAND_TONES: Record<MintAuthorityScoreFilterValue, PillarStripTone> = {
  hardened: "neutral",
  governed: "neutral",
  managed: "warn",
  concentrated: "warn",
  exposed: "critical",
  nr: "neutral",
};

/** What a group's count counts, by kind. Bridges are published per bridged deployment, not per route. */
const GROUP_NOUNS: Record<ControlComponentKind, string> = {
  bridge: "bridge controls",
  mint: "mint paths",
  oracle: "oracle paths",
  inventory: "inventory components",
};

const ADJUSTMENT_LABELS: Record<ControlAdjustmentKind, string> = {
  "unresolved-deployment-share": "unresolved deployment share",
  "operational-resilience-credit": "resilience credit",
  "dependency-limit": "dependency limit",
};

const ROLE_ORDER: Record<ControlComponentRole, number> = {
  limiting: 0,
  eligible: 1,
  diagnostic: 2,
  excluded: 3,
};

/** Producer labels arrive title-cased ("Margin And Liquidation"); strips print sentence case. */
const LABEL_ACRONYMS: Record<string, string> = {
  nav: "NAV",
  cdp: "CDP",
  psm: "PSM",
  rwa: "RWA",
  dex: "DEX",
  trs: "TRS",
  ucits: "UCITS",
  usd: "USD",
};

function scoreTone(score: number | null): PillarStripTone {
  if (score === null) return "neutral";
  const range = gradeRange(scoreToGrade(score));
  if (range === "F") return "critical";
  if (range === "C" || range === "D") return "warn";
  return "neutral";
}

function sentenceCaseLabel(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .map((word, index) => {
      const acronym = LABEL_ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      // Words the producer already wrote in caps are acronyms; keep them.
      if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      const lower = word.toLowerCase();
      return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    })
    .join(" ");
}

function headline(card: PillarStripCard, pillar: "backing" | "exit" | "control"): PillarStripHeadline {
  const published = card.pillars[pillar];
  const score = published.score;
  return {
    score,
    grade: score === null ? null : scoreToGrade(score),
    excluded: published.aggregationDisposition === "excluded-a-b" || score === null,
  };
}

function mechanismState(observationState: string): MechanismComponentState {
  if (observationState === "known") return "known";
  if (observationState === "stale") return "stale";
  return "unverified";
}

function buildBackingStrip(card: PillarStripCard): BackingStripView {
  const breakdown = card.breakdowns?.backing ?? null;
  return {
    pillar: "backing",
    ...headline(card, "backing"),
    groups: (breakdown?.groups ?? []).map((group) => ({
      key: group.key,
      label: group.label,
      score: group.score,
      weight: resolveV9EffectiveScoringWeight(group),
      tone: scoreTone(group.score),
    })),
    mechanism: (breakdown?.components ?? [])
      .filter((component) => component.source === "mechanism")
      .map((component) => ({
        key: component.key,
        label: sentenceCaseLabel(component.label),
        score: component.score,
        state: mechanismState(component.observationState),
        tone: scoreTone(component.score),
      })),
  };
}

/** Completion at or above this rounds to 100 % on screen, so it counts as filling the request. */
const CAPACITY_QUALIFIED_RATIO = 0.995;

/**
 * The selected route's capacity against the stress request. A route can be
 * selected as the best available while filling only part of the request
 * (EURC: $887k of $25m), so a shortfall warns and an empty fill is critical.
 * USDe's redemption fills $25m of $25m at a ratio a hair under 1, which is a
 * full fill, never a shortfall.
 */
function buildExitCapacity(route: NonNullable<ExitBreakdown["primaryRoute"]>): ExitStripCapacity | null {
  const capacity = route.capacity ?? null;
  if (capacity === null) return null;
  const ratio = capacity.executableUsd / capacity.requestedNotionalUsd;
  const completionRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  const qualified = completionRatio >= CAPACITY_QUALIFIED_RATIO &&
    !route.capsApplied.some((cap) => cap.startsWith("insufficient-completion:"));
  return {
    executableUsd: capacity.executableUsd,
    requestedNotionalUsd: capacity.requestedNotionalUsd,
    maxCostBps: capacity.maxCostBps,
    completionRatio,
    qualified,
    tone: qualified ? "neutral" : completionRatio > 0 ? "warn" : "critical",
  };
}

function excludedRouteReason(route: ExitBreakdown["alternatives"][number]): string {
  if (route.capacity?.executableUsd === 0) return "Zero executable capacity";
  return route.exclusionReason === null
    ? "No reason published"
    : humanizeSafetyScoreV9Value(route.exclusionReason);
}

function buildExitStrip(card: PillarStripCard): ExitStripView {
  const breakdown = card.breakdowns?.exit ?? null;
  const primary = breakdown?.primaryRoute ?? null;
  return {
    pillar: "exit",
    ...headline(card, "exit"),
    route: primary === null
      ? null
      : { label: describeExitRouteVenue(primary), family: primary.routeFamily, score: primary.score },
    backup: breakdown?.diversification && breakdown.diversification.bonus > 0
      ? { label: breakdown.diversification.routeLabel, bonus: breakdown.diversification.bonus }
      : null,
    capacity: primary === null ? null : buildExitCapacity(primary),
    stressRequest: breakdown?.stressRequest
      ? {
          requestedNotionalUsd: breakdown.stressRequest.requestedNotionalUsd,
          maxCostBps: breakdown.stressRequest.maxCostBps,
        }
      : null,
    excludedRoutes: primary !== null || breakdown === null
      ? []
      : breakdown.alternatives
          .filter((route) => !route.included)
          .map((route) => ({
            key: route.key,
            label: describeExitRouteVenue({ label: route.label, routeFamily: route.routeFamily }),
            score: route.score,
            reason: excludedRouteReason(route),
          })),
  };
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

/**
 * The native-issuance bridge row in the Bridging tile's words: the one tier
 * every reviewed route shares ("Issuer burn & mint"), else the majority tier
 * ("Mostly native"), else the tile's mixed chip ("Mixed · 1 unresolved",
 * "Mixed tiers"). Without an inventory the coin has no route to bridge,
 * which the tile calls "Single-chain / native".
 */
function nativeBridgeLabel(bridging: PillarStripBridging | null): string {
  const chainCount = bridging?.chainCount ?? 1;
  const present = BRIDGE_TIER_POLICY_ORDER.flatMap((tier) => {
    const count = bridging?.tierCounts[tier] ?? 0;
    return count > 0 ? [{ tier, count }] : [];
  });
  if (present.length === 0) return getBridgeTierLabel("single-chain-or-native", chainCount);
  if (present.length === 1) return getBridgeTierLabel(present[0]!.tier, chainCount);
  const reviewed = present.reduce((sum, entry) => sum + entry.count, 0);
  const lead = present.reduce((best, entry) => (entry.count > best.count ? entry : best));
  if (lead.count * 2 > reviewed) return `Mostly ${getBridgeTierLabel(lead.tier, chainCount).toLowerCase()}`;
  const unresolved = bridging?.unresolvedRouteCount ?? 0;
  return unresolved > 0 ? `Mixed · ${unresolved} unresolved` : "Mixed tiers";
}

/** Mint reads its published band ("Managed"), as the Mint Authority pill does; bridges read the tile's tier names. */
function controlPostureLabel(component: ControlBreakdownComponent, bridging: PillarStripBridging | null): string {
  if (component.kind === "mint") {
    const display = resolveMintAuthorityScoreDisplay({ score: component.score, posture: component.posture });
    if (display.bandKey !== "nr") return display.bandLabel;
  }
  if (component.kind === "bridge") {
    if (component.key === NATIVE_BRIDGE_KEY) return nativeBridgeLabel(bridging);
    if (isBridgeTier(component.posture)) return getBridgeTierLabel(component.posture, bridging?.chainCount ?? 1);
  }
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
export function resolveControlComponentRoles(
  card: PillarStripCard,
  bridging: PillarStripBridging | null = null,
): ControlComponentRoles | null {
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
    // The strip prints whole scores, so a sub-point adjustment (81 → 80.98)
    // leaves no visible gap to explain.
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
        postureLabel: controlPostureLabel(component, bridging),
        role,
        tone: controlComponentTone(component),
      };
    }),
  };
}

function byRoleThenScore(left: ControlStripComponent, right: ControlStripComponent): number {
  return ROLE_ORDER[left.role] - ROLE_ORDER[right.role] ||
    (left.score ?? Infinity) - (right.score ?? Infinity) ||
    left.key.localeCompare(right.key);
}

/**
 * Which row a component folds into, or null to keep it individual. Bridges
 * are the bulk of most Control breakdowns (31 of USDe's 33 components, 48 of
 * USDC's 49) and group by role. Every other non-eligible component groups by
 * kind, role and posture: ZCHF publishes 57 deployment-scoped mint paths, all
 * "Hardened" diagnostics. Eligible and limiting components outside bridges
 * always stay individual, since each one can set the minimum.
 */
function controlGroupKey(component: ControlStripComponent): string | null {
  if (component.kind === "bridge") return `bridge:${component.role}`;
  if (component.role === "diagnostic" || component.role === "excluded") {
    return `${component.kind}:${component.role}:${component.posture}`;
  }
  return null;
}

function controlGroupNoun(kind: ControlComponentKind, members: readonly ControlStripComponent[]): string {
  if (kind === "mint" && members.every((member) => member.key.startsWith(MINT_DEPLOYMENT_KEY_PREFIX))) {
    return "deployment mint paths";
  }
  return GROUP_NOUNS[kind];
}

/**
 * The producer publishes up to three kinds of mint component: `mint` (the
 * worst path overall), `mint:binding` (the worst binding path, only when it
 * differs) and `mint:deployment:*` (deployment-scoped paths, never binding).
 * Other kinds qualify their key the same way (`oracle:unverified`).
 */
function componentScope(component: ControlStripComponent): string | null {
  if (component.kind === "mint") {
    if (component.key.startsWith(MINT_DEPLOYMENT_KEY_PREFIX)) return "deployments";
    if (component.key === "mint:binding") return "binding path";
    return component.role === "limiting" || component.role === "eligible" ? "token-wide" : "worst path";
  }
  const qualifier = component.key.split(":").slice(1).join(" ").replace(/-/g, " ").trim();
  return qualifier === "" ? "all paths" : qualifier;
}

function groupRow(key: string, members: readonly ControlStripComponent[]): ControlStripRow {
  const first = members[0]!;
  const scored = members.filter((member) => member.score !== null);
  const lowest = scored.reduce<ControlStripComponent | null>(
    (min, member) => (min === null || member.score! < min.score! ? member : min),
    null,
  );
  const minScore = lowest?.score ?? null;
  const maxScore = scored.length === 0 ? null : Math.max(...scored.map((member) => member.score!));
  return {
    type: "group",
    group: {
      key,
      kind: first.kind,
      role: first.role,
      count: members.length,
      noun: controlGroupNoun(first.kind, members),
      postureLabel: first.kind === "bridge" ? null : first.postureLabel,
      minScore,
      maxScore,
      tone: lowest?.tone ?? "neutral",
    },
  };
}

function buildControlRows(
  components: readonly ControlStripComponent[],
  adjustments: readonly ControlStripAdjustment[],
): ControlStripRow[] {
  const groups = new Map<string, ControlStripComponent[]>();
  for (const component of components) {
    const key = controlGroupKey(component);
    if (key === null) continue;
    const existing = groups.get(key);
    if (existing) existing.push(component);
    else groups.set(key, [component]);
  }
  const ranked: Array<{ sortKey: ControlStripComponent; row: ControlStripRow }> = [];
  for (const component of components) {
    const key = controlGroupKey(component);
    if (key === null || (groups.get(key)?.length ?? 0) < MIN_GROUP) {
      ranked.push({ sortKey: component, row: { type: "component", component, scope: null } });
    }
  }
  for (const [key, members] of groups) {
    if (members.length < MIN_GROUP) continue;
    const representative = members.reduce((lowest, member) => byRoleThenScore(member, lowest) < 0 ? member : lowest);
    ranked.push({ sortKey: representative, row: groupRow(key, members) });
  }
  const rows = ranked.sort((left, right) => byRoleThenScore(left.sortKey, right.sortKey)).map((entry) => entry.row);

  // A scope suffix only where a kind has two or more rows (GHO: a token-wide
  // mint limiting at 25 beside its deployments at 100). Bridge labels
  // already name their chain.
  const rowsPerKind = new Map<ControlComponentKind, number>();
  for (const row of rows) {
    if (row.type === "unresolved-bridges") continue;
    const kind = row.type === "component" ? row.component.kind : row.group.kind;
    rowsPerKind.set(kind, (rowsPerKind.get(kind) ?? 0) + 1);
  }
  const scoped = rows.map((row): ControlStripRow =>
    row.type === "component" && row.component.kind !== "bridge" && (rowsPerKind.get(row.component.kind) ?? 0) > 1
      ? { ...row, scope: componentScope(row.component) }
      : row);

  // XAUT, USDP, SBC and USDGLO publish no bridge component: their bridged
  // supply is priced only by the unresolved-deployment-share adjustment.
  const unresolved = adjustments.find((adjustment) => adjustment.kind === "unresolved-deployment-share");
  if (unresolved && !components.some((component) => component.kind === "bridge")) {
    scoped.push({ type: "unresolved-bridges", delta: unresolved.delta });
  }
  return scoped;
}

function buildControlStrip(card: PillarStripCard, bridging: PillarStripBridging | null): ControlStripView {
  const roles = resolveControlComponentRoles(card, bridging);
  const adjustments = (card.breakdowns?.control.adjustments ?? []).map((adjustment) => ({
    kind: adjustment.kind,
    label: ADJUSTMENT_LABELS[adjustment.kind],
    delta: adjustment.delta,
  }));
  return {
    pillar: "control",
    ...headline(card, "control"),
    minimum: roles?.minimum ?? null,
    evaluatedScore: roles?.evaluatedScore ?? null,
    adjusted: roles?.adjusted ?? false,
    rows: roles === null ? [] : buildControlRows(roles.components, adjustments),
    adjustments,
  };
}

/**
 * One view model per pillar strip. Frozen coins and coins without a card get
 * null for every pillar: their boards keep only the kicker heading.
 */
export function buildPillarEvidenceStrips(
  card: PillarStripCard | null | undefined,
  options: { frozen?: boolean; bridging?: PillarStripBridging | null } = {},
): PillarEvidenceStrips {
  if (card == null || options.frozen === true) return { backing: null, exit: null, control: null };
  return {
    backing: buildBackingStrip(card),
    exit: buildExitStrip(card),
    control: buildControlStrip(card, options.bridging ?? null),
  };
}
