"use client";

import { CircleCheck, CircleDashed } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import {
  DeploymentStrip,
  type DeploymentStripBracket,
  type DeploymentStripCell,
} from "@/components/stablecoin-detail/deployment-strip";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, type EvidenceModuleVariant } from "@/components/stablecoin-detail/evidence-module";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import type { FailureDomainRow, FailureDomainShareSummary, FailureDomainsView } from "@/lib/failure-domains";
import type { ControlComponentRoles, ControlStripComponent, PillarStripTone } from "@/lib/pillar-evidence-strips";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import {
  bindBridgeRouteControlComponents,
  type BridgeRouteClientRow,
  type BridgeRouteRiskClientSummary,
} from "@/lib/stablecoin-detail-bridge-client";
import { cn } from "@/lib/utils";
import {
  BRIDGE_TIER_POLICY_ORDER,
  BRIDGE_TIER_SHORT_LABELS,
  CONTROL_COMPONENT_ROLE_LABELS,
  getBridgeTierLabel,
  type ControlComponentRole,
} from "@shared/lib/classification";
import { countSummaryWords, SUMMARY_VERDICT_MAX_WORDS } from "@shared/lib/summary-budget";
import type { BridgeRouteRiskTier } from "@shared/types";

/** Brackets stacked over the strip; the rest stay in the "Shared failure domains" fold. */
const BRACKET_LIMIT = 4;

const ROLE_ORDER: readonly ControlComponentRole[] = ["limiting", "eligible", "diagnostic", "excluded"];

const CHIP_CLASS = "border-border/60 bg-muted/30 text-[11px] font-medium text-muted-foreground";

/** Restrained score-pill tint, as on the Control strip: neutral unless the input is the problem. Never green. */
const SCORE_PILL_TONE_CLASS: Record<PillarStripTone, string> = {
  neutral: SEVERITY_TONE_CLASS.neutral.pill,
  warn: SEVERITY_TONE_CLASS.watch.pill,
  critical: SEVERITY_TONE_CLASS.alert.pill,
};

/** Stands in for the schema's placeholder tier on a route whose review is unresolved. */
const UNRESOLVED_TIER_LABEL = "Unresolved route";

export type BridgingDeploymentsForm = "tile" | "strip";

export interface BridgingDeploymentsModuleProps {
  /** Static projection (`coin.bridgeRouteRiskSummary`); null when the coin has no bridge review. */
  summary: BridgeRouteRiskClientSummary | null | undefined;
  /** `buildFailureDomainsView(card)`: deduped domains with the route spans they cover. */
  failureDomains: FailureDomainsView | null | undefined;
  /**
   * `card.breakdowns.control.components`; joins each route to its bridge
   * component (`bindBridgeRouteControlComponents`). Defaults to the
   * `controlRoles` components, which carry the same keys.
   */
  controlComponents?: readonly { key: string; kind: string }[] | null;
  /** `resolveControlComponentRoles(card)`: the only source of limiting / diagnostic roles. */
  controlRoles?: ControlComponentRoles | null;
  variant: EvidenceModuleVariant;
  stripForm?: boolean;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Whole percent from 10 %, one decimal below it, and never "0.0%" for a real sliver. */
function formatShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** One decimal at every size, for the fold's member detail, where rounding would lose the published share. */
function formatPreciseShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/**
 * A domain's share as a caption: the merged share, or, when part of the
 * domain is unquantified, the known members' share as a lower bound plus how
 * many members it leaves out. Null when no member is quantified. Bracket
 * captions pass the compact `formatShare`; the fold passes `formatPreciseShare`.
 */
function describeDomainShare(
  share: FailureDomainShareSummary,
  format: (value: number) => string,
): { label: string; note: string | null } | null {
  if (share.status === "quantified") return { label: format(share.exposureShare), note: null };
  if (share.status === "unquantified") return null;
  const known = format(share.knownShareLowerBound);
  return {
    // "≥<0.1%" reads as nonsense; a positive sliver is simply more than nothing.
    label: known.startsWith("<") ? ">0%" : `≥${known}`,
    note: `${share.unquantifiedMemberCount} unquantified`,
  };
}

function DomainShare({ share }: { share: FailureDomainShareSummary }) {
  const caption = describeDomainShare(share, formatPreciseShare);
  if (caption === null) return <span className="text-muted-foreground">Share unquantified</span>;
  return (
    <span className="text-muted-foreground">
      <span className="font-mono tabular-nums">{caption.label}</span>
      {caption.note ? ` · ${caption.note}` : null}
    </span>
  );
}

/** " Modeled contribution (capped): 12.0%." when the scoring share differs from the exposure. */
function modeledNote(exposureShare: number | null, modeledExposureShare: number | null): string {
  return modeledExposureShare !== null && exposureShare !== null && modeledExposureShare !== exposureShare
    ? ` Modeled contribution (capped): ${formatPreciseShare(modeledExposureShare)}.`
    : "";
}

/**
 * The layout the module needs: a tile when the strip has two or more route
 * cells to compare, otherwise strip form (single-chain / native coins, a
 * lone route, or failure domains without a bridge review). Null when there
 * is nothing to render; the caller owns any "Not reviewed" placeholder.
 */
export function resolveBridgingDeploymentsForm(
  summary: BridgeRouteRiskClientSummary | null | undefined,
  failureDomains: FailureDomainsView | null | undefined,
): BridgingDeploymentsForm | null {
  if (summary) return summary.routes.length > 1 ? "tile" : "strip";
  return failureDomains && failureDomains.rows.length > 0 ? "strip" : null;
}

/**
 * How the routes split by tier, over the full inventory (the counts the
 * legend shows), unresolved routes included. `all`: one reviewed tier and
 * nothing unresolved; `mostly`: the largest tier holds a strict majority of
 * every route; `mixed`: no tier does; `unresolved`: nothing is reviewed. The
 * lead is the largest tier, the better one on a tie.
 */
interface RouteMix {
  kind: "all" | "mostly" | "mixed" | "unresolved";
  lead: { tier: BridgeRouteRiskTier; count: number } | null;
  tierCount: number;
}

function describeRouteMix(summary: BridgeRouteRiskClientSummary): RouteMix {
  const present = BRIDGE_TIER_POLICY_ORDER.flatMap((tier) => {
    const count = summary.tierCounts[tier] ?? 0;
    return count > 0 ? [{ tier, count }] : [];
  });
  if (present.length === 0) return { kind: "unresolved", lead: null, tierCount: 0 };
  const unresolved = summary.unresolvedRouteCount;
  const total = present.reduce((sum, entry) => sum + entry.count, 0) + unresolved;
  const lead = present.reduce((best, entry) => (entry.count > best.count ? entry : best));
  const kind = present.length === 1 && unresolved === 0 ? "all" : lead.count * 2 > total ? "mostly" : "mixed";
  return { kind, lead, tierCount: present.length };
}

/**
 * Chip-length mix that fits a tile header beside the title: "All routes
 * native", "Mostly lock & mint", "Mixed · 1 unresolved", "Mixed tiers".
 * Tier counts belong to the verdict; only a mixed inventory, which has no
 * tier to name, states its unresolved routes.
 */
function describeMixChip(mix: RouteMix, unresolved: number): string {
  if (mix.lead === null) return "Unresolved routes";
  const short = BRIDGE_TIER_SHORT_LABELS[mix.lead.tier].toLowerCase();
  if (mix.kind === "all") return mix.lead.tier === "single-chain-or-native" ? "All routes native" : `All ${short}`;
  if (mix.kind === "mostly") return `Mostly ${short}`;
  return unresolved > 0 ? `Mixed · ${unresolved} unresolved` : "Mixed tiers";
}

/** Bridge components with a score, and the ones at the eligible Control minimum. */
function resolveBridgeRoles(controlRoles: ControlComponentRoles | null | undefined) {
  const scored = (controlRoles?.components ?? []).filter(
    (component) => component.kind === "bridge" && component.role !== "excluded",
  );
  return {
    limiting: scored.filter((component) => component.role === "limiting" && component.score !== null),
    allDiagnostic: scored.length > 0 && scored.every((component) => component.role === "diagnostic"),
  };
}

/**
 * The bridge components a route in the summary carries, by component key.
 * Engine components outside the route list (the `bridge:unverified` fallback)
 * stay unbound.
 */
function routesByComponentKey(
  summary: BridgeRouteRiskClientSummary | null | undefined,
  controlRoles: ControlComponentRoles | null | undefined,
): Map<string, BridgeRouteClientRow> {
  if (!summary) return new Map();
  const bound = bindBridgeRouteControlComponents(summary, controlRoles?.components ?? []);
  return new Map(bound.routes.flatMap((route) => (route.controlComponentKey ? [[route.controlComponentKey, route] as const] : [])));
}

/**
 * A limiting component's chip-length name: its route tier, or "Unverified"
 * for the engine's unbound opaque fallback (no reviewed bridge controls).
 */
function limitingShortLabel(component: ControlStripComponent, boundKeys: ReadonlyMap<string, unknown>): string {
  if (isUnverifiedFallback(component, boundKeys)) return "Unverified";
  return Object.hasOwn(BRIDGE_TIER_SHORT_LABELS, component.posture)
    ? BRIDGE_TIER_SHORT_LABELS[component.posture as BridgeRouteRiskTier]
    : component.postureLabel;
}

/** The engine's `bridge:unverified` fallback: an opaque bridge component no reviewed route carries. */
function isUnverifiedFallback(component: ControlStripComponent, boundKeys: ReadonlyMap<string, unknown>): boolean {
  return component.posture === "opaque-or-unknown" && !boundKeys.has(component.key);
}

type BridgingHeader =
  | { kind: "limiting"; score: number; toneClass: string; indexLabel: string }
  | { kind: "chip"; label: string };

/**
 * One status for the header and the rail index, read from the same fields the
 * strip draws:
 *
 * - a bridge component at the eligible Control minimum → its score pill and
 *   the limiting tag, never a tier chip (and never green);
 * - otherwise one neutral chip describing the route mix ("Mostly lock &
 *   mint", "Mixed · 1 unresolved"), the same label in the header and the
 *   index. A diagnostic role is keyed by the strip legend, not the header.
 *
 * A reviewed tier the route list disagrees with is stated in the notes fold,
 * not here.
 */
function resolveBridgingHeader(
  summary: BridgeRouteRiskClientSummary | null | undefined,
  failureDomains: FailureDomainsView | null | undefined,
  controlRoles: ControlComponentRoles | null | undefined,
): BridgingHeader | null {
  const hasDomains = failureDomains != null && failureDomains.rows.length > 0;
  if (!summary && !hasDomains) return null;
  const { limiting } = resolveBridgeRoles(controlRoles);
  const first = limiting[0];
  if (first) {
    return {
      kind: "limiting",
      score: Math.round(Math.min(...limiting.map((component) => component.score!))),
      toneClass: SCORE_PILL_TONE_CLASS[first.tone],
      indexLabel: limitingShortLabel(first, routesByComponentKey(summary, controlRoles)),
    };
  }
  if (!summary) return { kind: "chip", label: "Routes not reviewed" };
  if (summary.routeCount === 0) return { kind: "chip", label: summary.authoredTierLabel };
  const lone = summary.routeCount === 1 ? summary.routes[0] : undefined;
  if (lone) return { kind: "chip", label: lone.reviewed ? lone.tierLabel : UNRESOLVED_TIER_LABEL };
  return { kind: "chip", label: describeMixChip(describeRouteMix(summary), summary.unresolvedRouteCount) };
}

/**
 * The rail Evidence index chip: the limiting route tier, toned by its score,
 * when a bridge component limits Control; otherwise the header's own neutral
 * route-mix label. Null when the module has nothing to render.
 */
export function buildBridgingDeploymentsIndexChip(
  summary: BridgeRouteRiskClientSummary | null | undefined,
  failureDomains: FailureDomainsView | null | undefined,
  controlRoles: ControlComponentRoles | null | undefined,
): { label: string; toneClass: string } | null {
  const header = resolveBridgingHeader(summary, failureDomains, controlRoles);
  if (header === null) return null;
  return header.kind === "limiting"
    ? { label: header.indexLabel, toneClass: header.toneClass }
    : { label: header.label, toneClass: SEVERITY_TONE_CLASS.neutral.pill };
}

/**
 * A limiting bridge component that no drawn cell carries. The engine's
 * unverified fallback, or any component without a route mapping, bears on
 * the inventory as a whole: the strip outlines its whole band and captions
 * it, so green tier fills never read as safe beside a limiting pill. A
 * limiting route that a truncated strip did not draw is named on the
 * caveat line instead of outlining routes it is not.
 */
function resolveUncelledLimiting(
  limiting: readonly ControlStripComponent[],
  routeByComponentKey: ReadonlyMap<string, BridgeRouteClientRow>,
  routesTruncated: number,
): { bandCaption: string | null; caveat: string | null } {
  const uncelled = limiting.filter((component) => !routeByComponentKey.has(component.key));
  const undrawn = routesTruncated > 0
    ? uncelled.filter((component) => !isUnverifiedFallback(component, routeByComponentKey))
    : [];
  const band = uncelled.filter((component) => !undrawn.includes(component));
  return {
    bandCaption: band.length === 0
      ? null
      : band.every((component) => isUnverifiedFallback(component, routeByComponentKey))
        ? "Bridge controls unverified"
        : "Bridge control without a route mapping",
    caveat: undrawn.length > 0 ? "the limiting route is not among those drawn" : null,
  };
}

/**
 * Names what sets the Control minimum: "the Arbitrum route (external lock &
 * mint)", "4 external lock & mint routes", "unverified bridge controls".
 */
function describeLimiting(
  limiting: readonly ControlStripComponent[],
  boundRoutes: ReadonlyMap<string, BridgeRouteClientRow>,
  chainCount: number,
): string {
  const unverified = limiting.filter((component) => isUnverifiedFallback(component, boundRoutes));
  const routeComponents = limiting.filter((component) => !unverified.includes(component));
  const tiers = [...new Set(routeComponents.map((component) => component.posture))];
  const tierLabel = tiers.length === 1 && Object.hasOwn(BRIDGE_TIER_SHORT_LABELS, tiers[0]!)
    ? getBridgeTierLabel(tiers[0] as BridgeRouteRiskTier, chainCount).toLowerCase()
    : null;
  const loneRoute = routeComponents.length === 1 ? boundRoutes.get(routeComponents[0]!.key) : undefined;
  const routePart = routeComponents.length === 0
    ? null
    : loneRoute
      ? `the ${loneRoute.chainLabel} route (${loneRoute.tierLabel.toLowerCase()})`
      : `${routeComponents.length === 1 ? "one" : routeComponents.length}${tierLabel ? ` ${tierLabel}` : ""} ${
        routeComponents.length === 1 ? "route" : "routes"
      }`;
  const unverifiedPart = unverified.length > 0
    ? [...new Set(unverified.map((component) => component.label.charAt(0).toLowerCase() + component.label.slice(1)))].join(" and ")
    : null;
  return [routePart, unverifiedPart].filter((part): part is string => part !== null).join(" and ");
}

/** The first candidate within the verdict budget, else the shortest (last) one. */
function fitVerdict(candidates: readonly (readonly (string | null)[])[]): string {
  const texts = candidates.map((parts) => parts.filter((part): part is string => part !== null).join(" "));
  return texts.find((text) => countSummaryWords(text) <= SUMMARY_VERDICT_MAX_WORDS) ?? texts.at(-1)!;
}

/**
 * One generated sentence pair (≤ 25 words, `summary-budget.ts`) that agrees
 * with the drawn cells: what limits Control when a bridge component does,
 * then route and chain counts led by the majority tier, the weakest reviewed
 * tier, the third-party count (the legend's third-party tiers) and any
 * unresolved routes. Never clipped from the authored summary.
 */
export function buildBridgingDeploymentsVerdict(
  summary: BridgeRouteRiskClientSummary | null | undefined,
  failureDomains: FailureDomainsView | null | undefined,
  controlRoles?: ControlComponentRoles | null,
): string | null {
  const { limiting, allDiagnostic } = resolveBridgeRoles(controlRoles);
  const limitingSentence = limiting.length > 0
    ? `The Control minimum (${Math.round(Math.min(...limiting.map((component) => component.score!)))}) comes from ${
      describeLimiting(limiting, routesByComponentKey(summary, controlRoles), summary?.chainCount ?? 0)
    }.`
    : null;

  if (!summary) {
    const domainCount = failureDomains?.rows.length ?? 0;
    if (domainCount === 0) return null;
    return fitVerdict([[limitingSentence, `Bridge routes not reviewed; ${plural(domainCount, "shared failure domain")} traced.`]]);
  }
  if (summary.routeCount === 0) return fitVerdict([[limitingSentence, "No deployment routes in the review."]]);
  const lone = summary.routeCount === 1 ? summary.routes[0] : undefined;
  if (lone) {
    const loneSentence = !lone.reviewed
      ? `One route, on ${lone.chainLabel}; unresolved, tier not established.`
      : lone.protocolLabel === null
        ? `One native deployment, on ${lone.chainLabel}; no bridge route.`
        : `One route, on ${lone.chainLabel}: ${lone.tierLabel.toLowerCase()}.`;
    return fitVerdict([[limitingSentence, loneSentence]]);
  }

  const tierLabel = (tier: BridgeRouteRiskTier) => getBridgeTierLabel(tier, summary.chainCount).toLowerCase();
  const mix = describeRouteMix(summary);
  const unresolved = summary.unresolvedRouteCount;
  const counts = `${plural(summary.routeCount, "route")} on ${plural(summary.chainCount, "chain")}`;
  // The tier count the header chip leaves out; dropped first when the budget is tight.
  const mixPhrase = (withTierCount: boolean) =>
    mix.lead === null
      ? "none reviewed"
      : mix.kind === "all"
        ? `all ${tierLabel(mix.lead.tier)}`
        : mix.kind === "mostly"
          ? `mostly ${tierLabel(mix.lead.tier)} (${mix.lead.count})`
          : `${withTierCount ? `${mix.tierCount} tiers, ` : ""}largest ${tierLabel(mix.lead.tier)} (${mix.lead.count})`;
  const weakest = summary.weakestRouteTier;
  const weakestPhrase = mix.lead !== null && mix.kind !== "all" && weakest !== null && weakest !== mix.lead.tier
    ? `; weakest ${tierLabel(weakest)}`
    : "";
  const thirdParty = summary.thirdPartyRouteCount > 0
    ? `${summary.thirdPartyRouteCount} third-party (${Math.round((summary.thirdPartyRouteCount / summary.routeCount) * 100)}%)`
    : mix.kind === "mostly" || mix.kind === "mixed"
      ? "no third-party routes"
      : null;
  const tailParts = [thirdParty, unresolved > 0 ? `${unresolved} unresolved` : null]
    .filter((part): part is string => part !== null);
  const tail = tailParts.length > 0 ? `${tailParts.join("; ")}.` : null;
  const tailSentence = tail === null ? null : tail.charAt(0).toUpperCase() + tail.slice(1);
  const roleSentence = allDiagnostic ? "Bridges sit outside the Control minimum." : null;

  return fitVerdict([
    [limitingSentence, `${counts}, ${mixPhrase(true)}${weakestPhrase}.`, tailSentence, roleSentence],
    [limitingSentence, `${counts}, ${mixPhrase(true)}${weakestPhrase}.`, tailSentence],
    [limitingSentence, `${counts}, ${mixPhrase(true)}.`, tailSentence],
    [limitingSentence, `${counts}, ${mixPhrase(false)}.`, tailSentence],
    [limitingSentence, `${counts}, ${mixPhrase(false)}.`],
  ]);
}

/**
 * The reviewer's asset-wide tier when the route list disagrees with it (MAI:
 * reviewed external lock & mint over fifteen issuer burn & mint routes).
 * Stated in the notes fold so the chip and verdict stay with the drawn cells.
 */
function buildTierDisagreementNote(summary: BridgeRouteRiskClientSummary): string | null {
  const weakest = summary.weakestRouteTier;
  if (weakest === null || weakest === summary.authoredTier) return null;
  const authored = summary.authoredTierLabel.toLowerCase();
  const weakestLabel = getBridgeTierLabel(weakest, summary.chainCount).toLowerCase();
  const order: readonly BridgeRouteRiskTier[] = BRIDGE_TIER_POLICY_ORDER;
  return order.indexOf(summary.authoredTier) > order.indexOf(weakest)
    ? `The review rates the inventory ${authored} overall, weaker than every listed route (weakest: ${weakestLabel}).`
    : `The review rates the inventory ${authored} overall, better than its weakest listed route (${weakestLabel}).`;
}

interface RouteCell {
  route: BridgeRouteClientRow;
  cell: DeploymentStripCell;
}

/**
 * One cell per projected route. A chain carrying several routes names each by
 * protocol; only the first home-chain route (the native one: routes arrive
 * home first, then best tier) carries the home mark. A route's role comes
 * from its bound bridge component; unscored components make no claim.
 */
function buildRouteCells(
  summary: BridgeRouteRiskClientSummary,
  roleByKey: ReadonlyMap<string, ControlComponentRole>,
): RouteCell[] {
  const routesPerChain = new Map<string, number>();
  for (const route of summary.routes) routesPerChain.set(route.chainId, (routesPerChain.get(route.chainId) ?? 0) + 1);
  const usedKeys = new Set<string>();
  let homeMarked = false;
  return summary.routes.map((route, index) => {
    const key = usedKeys.has(route.key) ? `${route.key}#${index}` : route.key;
    usedKeys.add(key);
    const home = !homeMarked && route.chainId === summary.homeChainId;
    if (home) homeMarked = true;
    const role = route.controlComponentKey ? roleByKey.get(route.controlComponentKey) : undefined;
    return {
      route,
      cell: {
        key,
        label: (routesPerChain.get(route.chainId) ?? 0) > 1
          ? `${route.chainLabel} · ${route.protocolLabel ?? "native"}`
          : route.chainLabel,
        tierKey: route.tierKey,
        tierLabel: route.reviewed ? route.tierLabel : UNRESOLVED_TIER_LABEL,
        role: role === "excluded" ? undefined : role,
        home,
        unknown: !route.reviewed,
      },
    };
  });
}

/** Failure domains as brackets over the route cells they span, in the view's cost-then-share order. */
function buildBrackets(
  rows: readonly FailureDomainRow[],
  cells: readonly RouteCell[],
): { brackets: DeploymentStripBracket[]; spanningCount: number } {
  const brackets: DeploymentStripBracket[] = [];
  let spanningCount = 0;
  for (const row of rows) {
    const cellKeys = cells
      .filter(({ route }) =>
        row.span.chainIds.includes(route.chainId)
        || row.span.routeKeys.includes(route.key)
        || (route.protocolKey !== null && row.span.protocolKeys.includes(route.protocolKey)),
      )
      .map(({ cell }) => cell.key);
    if (cellKeys.length === 0) continue;
    spanningCount += 1;
    if (brackets.length >= BRACKET_LIMIT) continue;
    const share = describeDomainShare(row.share, formatShare);
    brackets.push({
      key: row.key,
      label: row.members.length > 1 ? `${row.label} ×${row.members.length}` : row.label,
      cellKeys,
      shareLabel: share?.label,
      shareNote: share?.note ?? undefined,
    });
  }
  return { brackets, spanningCount };
}

/**
 * Legend totals per tier label over the whole inventory, keyed by the labels
 * the cells carry, so a truncated strip's legend still counts every route.
 */
function buildLegendTotals(summary: BridgeRouteRiskClientSummary): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const tier of BRIDGE_TIER_POLICY_ORDER) {
    const count = summary.tierCounts[tier] ?? 0;
    if (count > 0) totals[getBridgeTierLabel(tier, summary.chainCount)] = count;
  }
  if (summary.unresolvedRouteCount > 0) totals[UNRESOLVED_TIER_LABEL] = summary.unresolvedRouteCount;
  return totals;
}

function ScoringBreakdown({
  components,
  minimum,
  routeByComponentKey,
}: {
  components: readonly ControlStripComponent[];
  minimum: number | null;
  routeByComponentKey: ReadonlyMap<string, BridgeRouteClientRow>;
}) {
  const groups = ROLE_ORDER.flatMap((role) => {
    const members = components.filter((component) => component.role === role);
    if (members.length === 0) return [];
    const scores = members.flatMap((member) => (member.score === null ? [] : [Math.round(member.score)]));
    const low = scores.length > 0 ? Math.min(...scores) : null;
    const high = scores.length > 0 ? Math.max(...scores) : null;
    // A component bound to a route counts as a route; the engine's fallbacks are bridge controls.
    const unit = members.every((member) => routeByComponentKey.has(member.key)) ? "route" : "bridge control";
    return [{
      role,
      count: members.length,
      unit,
      range: low === null ? "–" : low === high ? String(low) : `${low}–${high}`,
      names: [...new Set(members.map((member) => routeByComponentKey.get(member.key)?.chainLabel ?? member.label))].join(", "),
    }];
  });

  return (
    <ModuleDisclosure label="Scoring breakdown">
      <div className="mt-2 space-y-3 pb-1 text-xs">
        {minimum !== null ? (
          <p className="text-muted-foreground">
            Control minimum <span className="font-mono tabular-nums text-foreground">{Math.round(minimum)}</span>, before
            adjustments.
          </p>
        ) : null}
        <ul aria-label="Bridge components by role" className="space-y-2.5">
          {groups.map((group) => (
            <li key={group.role} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 font-medium text-foreground">{CONTROL_COMPONENT_ROLE_LABELS[group.role]}</span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                  {plural(group.count, group.unit)} · {group.range}
                </span>
              </div>
              <p className="leading-snug text-muted-foreground">{group.names}</p>
            </li>
          ))}
        </ul>
      </div>
    </ModuleDisclosure>
  );
}

function DomainMemberList({ row }: { row: FailureDomainRow }) {
  return (
    <ul aria-label={`${row.label} members`} className="mt-1 space-y-1.5 border-l border-border/60 pl-3">
      {row.members.map((member) => {
        const note = `${member.reason ?? ""}${modeledNote(member.exposureShare, member.modeledExposureShare)}`.trim();
        return (
          <li key={member.key} data-domain-member="" className="space-y-0.5 text-[11px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-foreground">
                {member.label}
                <span className="sr-only">: </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2 text-muted-foreground">
                {member.adjustmentPoints !== null && member.adjustmentPoints > 0 ? (
                  <span className="font-mono tabular-nums text-foreground">−{member.adjustmentPoints.toFixed(1)} pts</span>
                ) : null}
                {member.exposureShare === null ? (
                  <span>share unquantified</span>
                ) : (
                  <span className="font-mono tabular-nums">{formatPreciseShare(member.exposureShare)}</span>
                )}
                <span className="sr-only">. </span>
              </span>
            </div>
            {note ? <p className="leading-snug text-muted-foreground">{note}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One entry per domain. A domain the engine traced through several entries
 * lists every member with its own share and reason, so a partly quantified
 * domain never hides the shares that are known.
 */
function DomainList({ view }: { view: FailureDomainsView }) {
  return (
    <div className="space-y-3">
      <ul aria-label="Shared failure domains" className="space-y-2.5">
        {view.rows.map((row) => {
          const lone = row.members.length === 1 ? row.members[0] : undefined;
          const rowModeled = row.share.status === "quantified"
            ? modeledNote(row.share.exposureShare, row.share.modeledExposureShare)
            : "";
          const rowNote = `${lone?.reason ?? ""}${rowModeled}`.trim();
          return (
            <li key={row.key} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 font-medium text-foreground">
                  {row.label}
                  {row.members.length > 1 ? (
                    <span className="ml-1 font-mono tabular-nums text-muted-foreground">×{row.members.length}</span>
                  ) : null}
                  <span className="sr-only">: </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  {row.adjustmentPoints > 0 ? (
                    <span className="font-mono tabular-nums text-foreground">−{row.adjustmentPoints.toFixed(1)} pts</span>
                  ) : null}
                  <DomainShare share={row.share} />
                  <span className="sr-only">. </span>
                </span>
              </div>
              {rowNote ? <p className="text-[11px] leading-snug text-muted-foreground">{rowNote}</p> : null}
              {lone ? null : <DomainMemberList row={row} />}
            </li>
          );
        })}
      </ul>
      {view.totalAdjustmentPoints > 0 ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Shared failure domains cost this asset{" "}
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {view.totalAdjustmentPoints.toFixed(1)}
          </span>{" "}
          points of its Safety Score.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Control-board tile "Bridging & deployments" (plan §5): the reviewed bridge
 * routes and the shared failure domains behind them, merged into one module.
 *
 * - Header: the bridge score pill with the limiting tag when a bridge
 *   component sits at the eligible Control minimum (USTB's unverified bridge
 *   controls at 45); otherwise one neutral route-mix chip, short enough never
 *   to truncate in a tile header and the same label as the index chip. A
 *   diagnostic role (USDe's 31 OFT routes) is keyed by the strip legend and
 *   the Control strip, not the header. Chip, verdict and legend count the
 *   same routes.
 * - Visual: a `DeploymentStrip` with one cell per route, filled by bridge tier
 *   in published policy order, home chain marked. A limiting route is
 *   outlined, a diagnostic one dashed in its tier's hue; a limiting component
 *   no route carries (unverified bridge controls) outlines the whole band
 *   with a caption. The legend counts the whole inventory. Failure domains
 *   bracket the cells they span; an unquantified share reads "share
 *   unquantified", never a percent, and a partly quantified one reads as a
 *   lower bound with its unquantified member count ("≥21% · 1 unquantified").
 * - A single-chain / native coin, a lone route, or failure domains without a
 *   bridge review degrade to strip form: no one-cell strip.
 * - Disclosures in fixed order: Scoring breakdown → Shared failure domains
 *   (`#failure-domains`, on the fold itself) → Review notes & sources, which
 *   also states an authored tier the route list disagrees with.
 */
export function BridgingDeploymentsModule({
  summary,
  failureDomains,
  controlComponents,
  controlRoles,
  variant,
  stripForm = false,
}: BridgingDeploymentsModuleProps) {
  const form = resolveBridgingDeploymentsForm(summary, failureDomains);
  const header = resolveBridgingHeader(summary, failureDomains, controlRoles);
  const verdict = buildBridgingDeploymentsVerdict(summary, failureDomains, controlRoles);
  if (form === null) return null;

  const roleComponents = controlRoles?.components ?? [];
  // Role components carry the same `key` / `kind` pair, so they bind routes when the raw list is not passed.
  const bound = summary ? bindBridgeRouteControlComponents(summary, controlComponents ?? roleComponents) : null;
  const roleByKey = new Map(roleComponents.map((component) => [component.key, component.role]));
  const routeCells = bound && form === "tile" ? buildRouteCells(bound, roleByKey) : [];
  const domainView = failureDomains && failureDomains.rows.length > 0 ? failureDomains : null;
  const { brackets, spanningCount } = buildBrackets(domainView?.rows ?? [], routeCells);

  const bridgeComponents = roleComponents.filter((component) => component.kind === "bridge");
  const routeByComponentKey = new Map(
    (bound?.routes ?? []).flatMap((route) => (route.controlComponentKey ? [[route.controlComponentKey, route] as const] : [])),
  );

  const routesTruncated = form === "tile" ? (summary?.routesTruncated ?? 0) : 0;
  const uncelledLimiting = resolveUncelledLimiting(
    resolveBridgeRoles(controlRoles).limiting,
    routeByComponentKey,
    routesTruncated,
  );
  const caveats = [
    routesTruncated > 0 && summary
      ? `${summary.routes.length} of ${summary.routeCount} routes drawn in proportion; legend counts all ${summary.routeCount}`
      : null,
    uncelledLimiting.caveat,
    spanningCount > brackets.length ? `${brackets.length} of ${spanningCount} shared failure domains bracketed` : null,
  ].filter((part): part is string => part !== null);

  const pointCost = domainView?.totalAdjustmentPoints ?? 0;
  const tierNote = summary ? buildTierDisagreementNote(summary) : null;
  const notes = [tierNote, summary?.summary || null].filter((note): note is string => note !== null);

  const chips = [
    summary ? (
      <Badge key="confidence" variant="outline" className={CHIP_CLASS}>
        {summary.confidence === "verified" ? <CircleCheck aria-hidden /> : <CircleDashed aria-hidden />}
        Confidence: {summary.confidenceLabel}
      </Badge>
    ) : null,
    pointCost > 0 ? (
      <Badge key="cost" variant="outline" className={CHIP_CLASS}>
        Shared domains <span className="font-mono tabular-nums text-foreground">−{pointCost.toFixed(1)}</span> pts
      </Badge>
    ) : null,
  ].filter((node) => node !== null);

  const headerRight = header === null
    ? undefined
    : header.kind === "limiting"
      ? (
        <>
          <span className="sr-only">Bridge component score</span>
          <ScorePill
            label={String(header.score)}
            toneClass={header.toneClass}
            title={`Bridge component of the Control pillar: ${header.score} of 100, the Control minimum before adjustments.`}
          />
          <ControlRoleTag role="limiting" />
        </>
      )
      : (
        <Badge variant="outline" className={cn("text-[11px] font-medium", SEVERITY_TONE_CLASS.neutral.pill)}>
          {header.label}
        </Badge>
      );

  return (
    <EvidenceModule
      id="bridging"
      title="Bridging & deployments"
      variant={variant}
      stripForm={stripForm || form === "strip"}
      headerRight={headerRight}
      visual={routeCells.length > 1 && summary ? (
        <DeploymentStrip
          cells={routeCells.map(({ cell }) => cell)}
          brackets={brackets}
          ariaLabel="Bridge routes by tier"
          legendTotals={buildLegendTotals(summary)}
          caveats={caveats}
          bandLimiting={uncelledLimiting.bandCaption ?? undefined}
        />
      ) : undefined}
      verdict={verdict}
      chipRow={chips.length > 0 ? chips : undefined}
      folds={
        <>
          {bridgeComponents.length > 0 ? (
            <ScoringBreakdown
              components={bridgeComponents}
              minimum={controlRoles?.minimum ?? null}
              routeByComponentKey={routeByComponentKey}
            />
          ) : null}
          {domainView ? (
            <ModuleDisclosure
              id="failure-domains"
              className={SECTION_SCROLL_MT}
              label="Shared failure domains"
              count={domainView.rows.length}
            >
              <div className="mt-2 pb-1">
                <DomainList view={domainView} />
              </div>
            </ModuleDisclosure>
          ) : null}
        </>
      }
      footer={(
        <EvidenceFooter
          notes={notes.length > 0 ? notes.map((note) => <p key={note} className="whitespace-pre-line">{note}</p>) : undefined}
          notesCount={notes.length > 0 ? notes.length : undefined}
          sources={summary?.sources.map((source) => ({ label: source.label, url: source.url }))}
          reviewed={summary?.reviewedAt || undefined}
        />
      )}
    />
  );
}
