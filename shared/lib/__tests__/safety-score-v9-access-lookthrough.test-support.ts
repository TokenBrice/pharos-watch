import type { V9AccessClaimGraph, V9AccessClaimGraphReview } from "../../types/safety-score-v9-access-lookthrough";
import { requiredKnown } from "./safety-score-v9-fixtures.test-support";

export function makeAccessGraph(assetId = "alpha"): V9AccessClaimGraph {
  const status = requiredKnown("v9.access.freeze-review");
  const nodes = ["root", "receipt", "bridge", "token", "clean"].map((nodeKey) => ({ nodeKey, identity: { chainId: "ethereum", claimAddress: `claim:${nodeKey}` }, assetId: nodeKey === "root" ? assetId : null, noCurrentReach: nodeKey !== "token", status }));
  const serial = (edgeKey: string, fromNodeKey: string, toNodeKey: string): V9AccessClaimGraph["edges"][number] => ({ edgeKey, fromNodeKey, toNodeKey, kind: "receipt", positionKey: edgeKey, partitionKey: fromNodeKey, basis: { kind: "serial-claim", dependencyEdgeKey: null, entireClaim: true, currentImplementation: "verified-implementation" }, reachesHeldClaim: true, enabled: true, weight: 1, status });
  const reserve = (edgeKey: string, toNodeKey: string, weight: number): V9AccessClaimGraph["edges"][number] => ({ edgeKey, fromNodeKey: "root", toNodeKey, kind: "reserve-position", positionKey: edgeKey, partitionKey: "root", basis: { kind: "reserve-position", exposureKey: edgeKey, sourceKey: null }, reachesHeldClaim: true, enabled: true, weight, status });
  return { assetId, graphKey: `graph:${assetId}`, rootNodeKey: "root", clockSec: 1_790_849_876, generationId: "test-generation", nodes,
    edges: [reserve("position-a", "receipt", 0.4), reserve("position-b", "token", 0.3), reserve("position-clean", "clean", 0.3), serial("receipt-bridge", "receipt", "bridge"), { ...serial("bridge-token", "bridge", "token"), kind: "bridge-representation" }],
    authorities: [{ authorityKey: "origin:freeze", nodeKey: "token", actingDeployment: { chainId: "ethereum", claimAddress: "claim:token" }, controllerKey: null, capability: "freeze", reach: "current", failureDomains: [{ kind: "reserve-issuer", key: "origin" }], status }],
    partitions: ["root", "receipt", "bridge"].map((partitionKey) => ({ partitionKey, nodeKey: partitionKey, disjoint: true, complete: true, denominatorEstablished: true, status })), unresolved: [],
  };
}
export function makeAccessReview(assetId = "alpha", reviewedAt = "2026-01-01T00:00:00Z"): V9AccessClaimGraphReview {
  const { clockSec: _clock, generationId: _generation, ...graph } = makeAccessGraph(assetId);
  const review = { reviewedAt, sources: ["https://example.com/verified-claim"], responsibility: "integration-missing" as const };
  return { ...graph,
    nodes: graph.nodes.map(({ status: _status, ...node }) => ({ ...node, review })),
    edges: graph.edges.map(({ status: _status, weight: _weight, ...edge }) => ({ ...edge, review })),
    authorities: graph.authorities.map(({ status: _status, ...authority }) => ({ ...authority, review })),
    partitions: graph.partitions.map(({ status: _status, denominatorEstablished: _denominator, ...partition }) => ({ ...partition, review })), unresolved: [],
  };
}
