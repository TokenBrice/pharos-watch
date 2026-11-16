import { formatV9ReasonCodeLabel } from "@/lib/safety-score-reason-code-labels";
import { buildDirectHubExposures, exposureKnown, type HubExposure, type SupplyOf } from "@shared/lib/dependency-exposure";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import type { PublishedCollateralUsageEntry } from "./collateral-usage-section";

export interface DetailDependencyContext {
  exposure: HubExposure | undefined;
  /** False when no direct dependent has both known supply and known share: the total is not an observed $0. */
  directKnown: boolean;
  upstreams: PublishedCollateralUsageEntry[];
}

/**
 * Share of a dependent's backing, at the one precision every dependency list
 * uses. A positive share too small to print keeps its bound ("<0.1%") rather
 * than rounding to zero.
 */
export function formatDependencyShare(share: number): string {
  const pct = share * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  if (pct > 99.9 && pct < 100) return ">99.9%";
  return `${Number(pct.toFixed(1))}%`;
}

/**
 * Reader sentences for the coverage reasons the publisher emits: reserve-mapping
 * rejections, diagnostic issue codes (which carry an `:<assetId>` suffix) and
 * V9 gap codes. Anything unlisted falls back to the V9 reason-code labels.
 */
const COVERAGE_REASON_LABELS: Readonly<Record<string, string>> = {
  "no-match": "Reserve line not matched to a tracked asset",
  expired: "Reserve review has expired",
  "non-link": "Reserve line is not a claim on another asset",
  "coinId-without-depType": "Relationship type not reviewed yet",
  "reviewed-dependency-type-conflict": "Reviewed relationship type conflicts with reserve data",
  "reviewed-dependency-identity-conflict": "Reviewed identity conflicts with reserve data",
  "manual-collateral-not-in-reserves": "Listed collateral not found in reported reserves",
  "outside-active-set": "Not an actively scored stablecoin",
  "invalid-serial-weight": "Published relationship data failed validation",
  "invalid-serial-type": "Published relationship data failed validation",
  "invalid-basket-type": "Published relationship data failed validation",
  "invalid-role-type": "Published relationship data failed validation",
  "collateral-weight-exceeds-one": "Collateral shares add up to more than 100%",
  "self-dependency": "Listed as depending on itself",
  "identity-unverified": "Exact claim identity unverified",
  "stale-evidence": "Evidence is out of date",
};

export function coverageReasonLabel(reason: string): string {
  const code = reason.split(":")[0] ?? reason;
  const label = COVERAGE_REASON_LABELS[code] ?? formatV9ReasonCodeLabel(code);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

type CoverageRow = NonNullable<SafetyScoreV9CurrentCard["dependencyCoverage"]>[number];

export interface CoverageReasonGroup {
  label: string;
  rows: CoverageRow[];
  /** Identity and source date stated once when every row in the group agrees. */
  shared: { identityVerified: boolean; sourceAsOf: string | null } | null;
}

/** One group per reader sentence (first-seen order), rows by share, unknown shares last. */
export function groupCoverageByReason(rows: readonly CoverageRow[]): CoverageReasonGroup[] {
  const groups = new Map<string, CoverageRow[]>();
  for (const row of rows) {
    const label = coverageReasonLabel(row.reason);
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  return [...groups].map(([label, group]) => {
    const sorted = [...group].sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || a.upstreamLabel.localeCompare(b.upstreamLabel));
    const [first] = sorted;
    const uniform = sorted.every((row) => row.identityVerified === first!.identityVerified && row.sourceAsOf === first!.sourceAsOf);
    return { label, rows: sorted, shared: uniform ? { identityVerified: first!.identityVerified, sourceAsOf: first!.sourceAsOf } : null };
  });
}

/** True when at least one disclosure has a published row; absent and empty lists both count as no row. */
export function hasDependencyContextRows(card: SafetyScoreV9CurrentCard, context: DetailDependencyContext): boolean {
  return (context.exposure?.dependentCount ?? 0) > 0
    || context.upstreams.length > 0
    || (card.dependencies.roles?.length ?? 0) > 0
    || (card.dependencyCoverage?.length ?? 0) > 0;
}

export function buildDetailDependencyContext(
  stablecoinId: string,
  cards: readonly Pick<SafetyScoreV9CurrentCard, "id" | "sharedBookId">[],
  publishedEdges: readonly ReportCardsV9DependencyEdge[],
  mcapMap: ReadonlyMap<string, number | null>,
  marketCapAsOf: number | null,
): DetailDependencyContext {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const edges = publishedEdges.filter((edge) => cardById.has(edge.from) && cardById.has(edge.to));
  const supplyOf: SupplyOf = (id) => {
    const usd = mcapMap.get(id);
    return usd === undefined || usd === null || !Number.isFinite(usd) || usd < 0
      ? null : { usd, asOf: marketCapAsOf, basis: "market-cap-proxy" };
  };
  const exposure = buildDirectHubExposures(edges, supplyOf, {
    sharedBooks: {
      bookIdOf: (id) => cardById.get(id)?.sharedBookId ?? null,
      // The publication names shared books but does not publish measured holdings.
      measuredHoldingUsd: () => null,
    },
    familyOf: () => null,
    wrapperFormOf: () => "unknown",
  }).find((hub) => hub.hubId === stablecoinId);
  const upstreams: PublishedCollateralUsageEntry[] = edges.filter((edge) => edge.to === stablecoinId).map((edge) => {
    const upstream = CLIENT_TRACKED_META_BY_ID.get(edge.from);
    const dependent = CLIENT_TRACKED_META_BY_ID.get(edge.to);
    return {
      coin: { id: edge.from, name: upstream?.name ?? edge.from, symbol: upstream?.symbol ?? edge.from },
      edgeType: edge.kind,
      relationshipType: edge.dependencyType ?? (edge.kind === "basket" ? "collateral"
        : dependent?.variantOf === edge.from ? "wrapper" : "serial-claim"),
      weight: edge.weight,
      marketCap: mcapMap.get(edge.from) ?? null,
    };
  });
  const directKnown = exposure ? exposureKnown(exposure.direct, edges.filter((edge) => edge.from === stablecoinId)) : true;
  return { exposure, directKnown, upstreams };
}
