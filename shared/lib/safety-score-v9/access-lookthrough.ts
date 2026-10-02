import { V9AccessClaimGraphSchema, V9AccessLookthroughSummarySchema, v9AccessClaimGraphStatuses, type V9AccessClaimGraph, type V9AccessLookthroughSummary } from "../../types/safety-score-v9-access-lookthrough";
import type { V9FactStatusV2 } from "../../types/safety-score-v9-fact-primitives";
import { compareText, uniqueSorted } from "./primitives";

function known(status: V9FactStatusV2): boolean {
  return status.observationState === "known" && status.applicability.state === "required";
}
export function resolveV9AccessClaimGraph(input: unknown): V9AccessClaimGraph {
  return V9AccessClaimGraphSchema.parse(input);
}
/** Categorical reserve-access diagnostics only: no scores, supply shares or loss estimates. */
export function evaluateV9AccessLookthrough(input: V9AccessClaimGraph): V9AccessLookthroughSummary {
  const graph = resolveV9AccessClaimGraph(input);
  const nodes = new Map(graph.nodes.map((n) => [n.nodeKey, n]));
  const outgoing = new Map<string, V9AccessClaimGraph["edges"]>();
  for (const edge of graph.edges) outgoing.set(edge.fromNodeKey, [...(outgoing.get(edge.fromNodeKey) ?? []), edge]);
  const partitions = new Map(graph.partitions.map((p) => [p.partitionKey, p]));
  const authorityPaths = new Map<string, V9AccessLookthroughSummary["authorities"][number]["paths"]>();
  const unresolved = [...graph.unresolved.map(({ status: _status, ...row }) => row)];
  let priced = true;
  type Leaf = { positions: string[]; share: number | null; category: "adverse" | "none" | "unknown" };
  const leaves: Leaf[] = [];
  function unknown(nodeKey: string, reason: string, suffix: string) {
    unresolved.push({ branchKey: `${graph.graphKey}:${suffix}`, nodeKey, reason, responsibility: "integration-missing" });
  }
  function walk(nodeKey: string, share: number | null, edgeKeys: string[], positions: string[], ancestors: Set<string>, inheritedAdverse: boolean, inheritedUnknown: boolean) {
    if (ancestors.has(nodeKey)) {
      priced = false; unknown(nodeKey, "cycle", `cycle:${edgeKeys.join(":")}`); return;
    }
    const nextAncestors = new Set(ancestors); nextAncestors.add(nodeKey);
    const node = nodes.get(nodeKey)!;
    if (!known(node.status)) {
      leaves.push({ positions, share, category: inheritedAdverse ? "adverse" : "unknown" });
      unknown(nodeKey, node.status.observationState === "stale" ? "stale" : "research-incomplete", `node:${nodeKey}`);
      return;
    }
    let adverse = inheritedAdverse;
    let possible = false;
    let localCurrent = false;
    for (const authority of graph.authorities.filter((a) => a.nodeKey === nodeKey)) {
      const exact = authority.actingDeployment.chainId === node.identity.chainId && authority.actingDeployment.claimAddress === node.identity.claimAddress;
      if (!exact) { possible = true; unknown(nodeKey, "deployment-mismatch", `authority:${authority.authorityKey}`); continue; }
      if (!known(authority.status)) { possible = true; unknown(nodeKey, authority.status.observationState === "stale" ? "stale" : "research-incomplete", `authority:${authority.authorityKey}`); continue; }
      if (authority.reach === "possible" || authority.reach === "unknown") possible = true;
      if (authority.reach !== "current" && authority.reach !== "possible") continue;
      const paths = authorityPaths.get(authority.authorityKey) ?? [];
      paths.push({ edgeKeys, positionKeys: positions, knownReachShare: share });
      authorityPaths.set(authority.authorityKey, paths);
      adverse ||= authority.reach === "current";
      localCurrent ||= authority.reach === "current";
    }
    const unresolvedLocal = inheritedUnknown || possible || (!node.noCurrentReach && !localCurrent);
    if (!node.noCurrentReach && !localCurrent) unknown(nodeKey, "research-incomplete", `local:${nodeKey}`);
    const edges = outgoing.get(nodeKey) ?? [];
    if (edges.length === 0) {
      if (edgeKeys.length === 0) priced = false;
      const category = adverse ? "adverse" : !unresolvedLocal ? "none" : "unknown";
      leaves.push({ positions, share, category });
      if (category === "unknown") unknown(nodeKey, "research-incomplete", `leaf:${nodeKey}`);
      return;
    }
    const partitionKeys = uniqueSorted(edges.map((e) => e.partitionKey));
    if (partitionKeys.length !== 1) { priced = false; unknown(nodeKey, "overlap", `partitions:${nodeKey}`); }
    for (const partitionKey of partitionKeys) {
      const partition = partitions.get(partitionKey)!;
      const partitionEdges = edges.filter((e) => e.partitionKey === partitionKey);
      const weights = new Map<string, number>();
      let partitionPriced = partitionKeys.length === 1 && known(partition.status) && partition.disjoint && partition.denominatorEstablished;
      for (const edge of partitionEdges) {
        if (!known(edge.status) || !edge.enabled || !edge.reachesHeldClaim || edge.weight === null) partitionPriced = false;
        if (edge.weight !== null) {
          const old = weights.get(edge.positionKey);
          if (old !== undefined && old !== edge.weight) { partitionPriced = false; unknown(nodeKey, "overlap", `position:${edge.positionKey}`); }
          weights.set(edge.positionKey, edge.weight);
        }
      }
      const total = [...weights.values()].reduce((a, b) => a + b, 0);
      if (total > 1 + 1e-8 || (partition.complete && Math.abs(total - 1) > 1e-8)) partitionPriced = false;
      if (!partitionPriced) { priced = false; unknown(nodeKey, partition.disjoint ? "scope-unreconciled" : "overlap", `partition:${partitionKey}`); }
      if (partitionPriced && total < 1 - 1e-8) {
        leaves.push({ positions: [...positions, `${partitionKey}:remainder`], share: share === null ? null : share * (1 - total), category: adverse ? "adverse" : "unknown" });
        unknown(nodeKey, "scope-unreconciled", `remainder:${partitionKey}`);
      }
      for (const edge of partitionEdges) {
        const admitted = known(edge.status) && edge.enabled && edge.reachesHeldClaim;
        const nextShare = partitionPriced && share !== null && edge.weight !== null ? share * edge.weight : null;
        if (!admitted) {
          leaves.push({ positions: [...positions, edge.positionKey], share: nextShare, category: "unknown" });
          unknown(nodeKey, "claim-inapplicable", `edge:${edge.edgeKey}`);
        } else walk(edge.toNodeKey, nextShare, [...edgeKeys, edge.edgeKey], edge.basis.kind === "serial-claim" && edge.weight === 1 ? positions : [...positions, edge.positionKey], nextAncestors, adverse, unresolvedLocal);
      }
    }
  }
  walk(graph.rootNodeKey, 1, [], [], new Set(), false, false);
  if (graph.unresolved.length > 0) priced = false;
  const union = new Map<string, Leaf>();
  for (const leaf of leaves) {
    const key = JSON.stringify(leaf.positions);
    const previous = union.get(key);
    if (previous && previous.share !== leaf.share) { priced = false; unknown(graph.rootNodeKey, "overlap", `union:${key}`); }
    if (!previous || leaf.category === "adverse" || (previous.category === "none" && leaf.category === "unknown")) union.set(key, leaf);
  }
  let adverseShare = 0, noReachShare = 0, unknownShare = 0;
  for (const leaf of union.values()) {
    if (leaf.share === null) { priced = false; continue; }
    if (leaf.category === "adverse") adverseShare += leaf.share;
    else if (leaf.category === "none") noReachShare += leaf.share;
    else unknownShare += leaf.share;
  }
  if (Math.abs(adverseShare + noReachShare + unknownShare - 1) > 1e-8) priced = false;
  const authorities = graph.authorities.flatMap(({ status: _status, ...authority }) => {
    const paths = authorityPaths.get(authority.authorityKey);
    if (!paths) return [];
    paths.sort((a, b) => compareText(JSON.stringify(a.edgeKeys), JSON.stringify(b.edgeKeys)));
    const coverage = new Map<string, typeof paths[number]>();
    for (const path of paths) coverage.set(JSON.stringify(path.positionKeys), path);
    const minimal = [...coverage.values()].filter((path, _, all) => !all.some((other) => other !== path && other.positionKeys.length < path.positionKeys.length && other.positionKeys.every((p, i) => path.positionKeys[i] === p)));
    const quantified = priced && minimal.every((p) => p.knownReachShare !== null);
    const reach = quantified ? minimal.reduce((sum, p) => sum + p.knownReachShare!, 0) : null;
    return [{ ...authority, knownReachShare: authority.reach === "current" ? reach : null, unresolvedReachShare: quantified ? unknownShare : null, paths: paths.map((p) => ({ ...p, knownReachShare: priced && authority.reach === "current" ? p.knownReachShare : null })) }];
  });
  const byBranch = new Map(unresolved.map((row) => [row.branchKey, row]));
  return V9AccessLookthroughSummarySchema.parse({
    diagnosticOnly: true, coverageState: priced && unknownShare === 0 && byBranch.size === 0 ? "complete" : "incomplete",
    knownAdverseReachShare: priced ? adverseShare : null, reviewedNoCurrentReachShare: priced ? noReachShare : null,
    unresolvedCoverageShare: priced ? unknownShare : null, authorities, unresolved: [...byBranch.values()],
    evidenceRefIds: uniqueSorted(v9AccessClaimGraphStatuses(graph).flatMap((s) => s.status.evidenceRefIds)),
  });
}
