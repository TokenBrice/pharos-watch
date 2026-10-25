import { buildDependencyHubsModel } from "@shared/lib/dependency-hubs-model";
import { formatCurrency } from "@shared/lib/format";
import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { projectDependencyGraph } from "@shared/types/dependency-graph";
import { loadActiveSafetyScoreCohort } from "../../lib/safety-score-active-source";
import { logWorkerEvent } from "../../lib/structured-log";
import { loadStablecoinsCache } from "../../lib/stablecoins-cache";
import { freshnessReason, unavailable, type OgPageLoader, OG_SOURCE_BUDGET_SEC } from "./types";

/**
 * `/dependency-map` hero: "Mapped direct exposure", built exactly as the map
 * client builds it — the `/api/dependency-graph/v1` projection of the accepted
 * publication plus current market caps from `/api/stablecoins`.
 */
export const loadDependencyMapOgPage: OgPageLoader = async (db, nowSec) => {
  const [active, stablecoins] = await Promise.all([
    loadActiveSafetyScoreCohort(db),
    loadStablecoinsCache(db, { mode: "strict", contract: "published" }),
  ]);
  if (active.projectionFallbackCount > 0) logWorkerEvent({
    scope: "api", level: "warn", event: "safety-cohort-reader-fallback", route: "/api/og/page/dependency-map",
    message: "Dependency map OG read used the transitional cohort fallback",
    metadata: { safetyProjectionFallbackCount: active.projectionFallbackCount },
  });
  if (active.kind === "error") return unavailable("owner-error");
  if (stablecoins.kind !== "ok") return unavailable("cache-missing");
  const graph = projectDependencyGraph(active.snapshot);
  if (graph.publicationStatus === "held") return unavailable("held-publication");
  const graphStale = freshnessReason(nowSec, graph.updatedAt, OG_SOURCE_BUDGET_SEC.reportCards);
  if (graphStale) return unavailable(graphStale);
  const marketStale = freshnessReason(nowSec, stablecoins.updatedAt, OG_SOURCE_BUDGET_SEC.stablecoins);
  if (marketStale) return unavailable(marketStale);
  // The hero depends on both reads: stamp the older and expire with whichever leaves its budget first.
  const graphFreshUntil = graph.updatedAt + OG_SOURCE_BUDGET_SEC.reportCards;
  const marketFreshUntil = stablecoins.updatedAt + OG_SOURCE_BUDGET_SEC.stablecoins;

  const mcapMap = new Map(stablecoins.payload.peggedAssets.map((asset) => [asset.id, getCirculatingRawOrNull(asset)]));
  const cards = graph.nodes.map((node) => {
    const meta = CLIENT_TRACKED_META_BY_ID.get(node.id);
    return { id: node.id, name: meta?.name ?? node.id, symbol: meta?.symbol ?? node.id, sharedBookId: node.sharedBookId };
  });
  const model = buildDependencyHubsModel({ cards, edges: graph.edges, mcapMap, marketCapAsOf: stablecoins.updatedAt });
  if (model.directEdgeCount === 0) return unavailable("figure-null");
  // The page publishes the known subtotal with an exclusion note; the card carries the same note.
  const excluded = model.mappedSupply.excludedSupplyUnknownIds.length;
  if (model.uniqueDirectDependentCount <= excluded) return unavailable("figure-null");

  return {
    kind: "ok",
    hero: formatCurrency(model.mappedSupply.knownUsd, 2),
    context: "dependents' supply mapped to tracked upstreams (gross)",
    support: [`${model.upstreamHubCount} upstream hubs`, `${model.uniqueDirectDependentCount} direct dependents`],
    asOfSec: Math.min(graph.updatedAt, stablecoins.updatedAt),
    budgetSec: graphFreshUntil < marketFreshUntil ? OG_SOURCE_BUDGET_SEC.reportCards : OG_SOURCE_BUDGET_SEC.stablecoins,
    freshUntilSec: Math.min(graphFreshUntil, marketFreshUntil),
    generation: `${graph.publicationGenerationId}+stablecoins:${stablecoins.updatedAt}`,
    stampNote: [
      `methodology v${graph.methodologyVersion}`,
      ...(excluded > 0 ? [`excl. ${excluded} ${excluded === 1 ? "coin" : "coins"} without supply data`] : []),
    ].join(" · "),
  };
};
