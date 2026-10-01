import { describe, expect, it } from "vitest";
import { evaluateV9AccessLookthrough, resolveV9AccessClaimGraph } from "../safety-score-v9/access-lookthrough";
import { evaluateV9AccessPosture } from "../safety-score-v9/access-posture";
import { V9_CANDIDATE_POLICY_V1, loadV9MethodologyPolicy } from "../safety-score-v9/policy";
import { ACCESS_LOOKTHROUGH_CAPABILITY_LABELS, ACCESS_LOOKTHROUGH_COVERAGE_LABELS, ACCESS_LOOKTHROUGH_REASON_LABELS } from "../classification";
import { makeAccessGraph } from "./safety-score-v9-access-lookthrough.test-support";
import { requiredKnown } from "./safety-score-v9-fixtures.test-support";

function posture(graph = makeAccessGraph()) {
  return evaluateV9AccessPosture({ policy: V9_CANDIDATE_POLICY_V1, facts: { assetId: graph.assetId, controls: [], exitRoutes: [], controlStatus: requiredKnown("control"), exitStatus: requiredKnown("exit") },
    transfer: { status: requiredKnown("transfer"), posture: "permissionless" }, freezeReviews: [], claimGraph: graph });
}
describe("reviewed reserve-access look-through", () => {
  it("retains every receipt/bridge hop and unions disjoint positions without changing local transfer", () => {
    const result = posture();
    expect(result.transfer).toBe("permissionless");
    expect(result.freezeExposure).toBe("upstream");
    expect(result.freezeLookthrough).toMatchObject({ diagnosticOnly: true, coverageState: "complete", knownAdverseReachShare: 0.7, reviewedNoCurrentReachShare: 0.3, unresolvedCoverageShare: 0 });
    expect(result.freezeLookthrough!.authorities[0]).toMatchObject({ authorityKey: "origin:freeze", controllerKey: null, knownReachShare: 0.7 });
    expect(result.freezeLookthrough!.authorities[0]!.paths.map((p) => p.edgeKeys)).toEqual([["position-a", "receipt-bridge", "bridge-token"], ["position-b"]]);
    const permuted = makeAccessGraph();
    permuted.nodes.reverse(); permuted.edges.reverse(); permuted.partitions.reverse();
    expect(evaluateV9AccessLookthrough(permuted)).toEqual(result.freezeLookthrough);
  });
  it("deduplicates two routes through the same physical position rather than counting 80%", () => {
    const graph = makeAccessGraph();
    graph.edges.push({ ...graph.edges[0]!, edgeKey: "alternate-route" });
    expect(evaluateV9AccessLookthrough(graph).knownAdverseReachShare).toBe(0.7);
    expect(evaluateV9AccessLookthrough(graph).authorities[0]!.knownReachShare).toBe(0.7);
  });
  it("keeps multiple originating authorities non-additive, including a smaller origin", () => {
    const graph = makeAccessGraph();
    graph.authorities.push({ ...graph.authorities[0]!, authorityKey: "origin:pause", capability: "pause", nodeKey: "clean", actingDeployment: graph.nodes.find((n) => n.nodeKey === "clean")!.identity });
    graph.nodes.find((node) => node.nodeKey === "clean")!.noCurrentReach = false;
    const result = evaluateV9AccessLookthrough(graph);
    expect(result.authorities.map((a) => [a.authorityKey, a.knownReachShare])).toEqual([["origin:freeze", 0.7], ["origin:pause", 0.3]]);
    graph.authorities[1] = { ...graph.authorities[0]!, authorityKey: "origin:pause", capability: "pause" };
    graph.nodes.find((node) => node.nodeKey === "clean")!.noCurrentReach = true;
    const overlap = evaluateV9AccessLookthrough(graph);
    expect(overlap.authorities.map((a) => a.knownReachShare)).toEqual([0.7, 0.7]);
    expect(overlap.knownAdverseReachShare).toBe(0.7);
  });
  it("preserves priced partial remainder without renormalizing the known origin", () => {
    const graph = makeAccessGraph();
    graph.edges = graph.edges.filter((e) => e.toNodeKey !== "clean");
    graph.partitions.find((p) => p.partitionKey === "root")!.complete = false;
    const result = posture(graph);
    expect(result.freezeExposure).toBe("upstream");
    expect(result.freezeLookthrough).toMatchObject({ coverageState: "incomplete", knownAdverseReachShare: 0.7, unresolvedCoverageShare: 0.30000000000000004 });
  });
  it("publishes qualitative origin identities, never zero, without an admitted denominator", () => {
    const graph = makeAccessGraph();
    graph.edges[0]!.weight = null;
    const result = posture(graph);
    expect(result.freezeExposure).toBe("upstream");
    expect(result.freezeLookthrough!.knownAdverseReachShare).toBeNull();
    expect(result.freezeLookthrough!.authorities[0]!.knownReachShare).toBeNull();
    expect(result.freezeLookthrough!.unresolvedCoverageShare).toBeNull();
  });
  it("never borrows a Solana authority for an Ethereum holding, or treats a mismatch as known negative", () => {
    const graph = makeAccessGraph();
    graph.authorities[0]!.actingDeployment.chainId = "solana";
    graph.nodes.find((n) => n.nodeKey === "token")!.noCurrentReach = true;
    const result = posture(graph);
    expect(result.freezeExposure).toBe("unknown");
    expect(result.freezeLookthrough!.knownAdverseReachShare).toBe(0);
    expect(result.freezeLookthrough!.unresolvedCoverageShare).toBe(0.7);
    expect(result.freezeLookthrough!.unresolved.some((u) => u.reason === "deployment-mismatch")).toBe(true);
  });
  it("requires complete reviewed negative coverage and distinguishes true zero from unknown", () => {
    const graph = makeAccessGraph(); graph.authorities = [];
    graph.nodes.find((n) => n.nodeKey === "token")!.noCurrentReach = true;
    expect(posture(graph).freezeExposure).toBe("none-known");
    expect(posture(graph).freezeLookthrough!.knownAdverseReachShare).toBe(0);
    graph.partitions[0]!.denominatorEstablished = false;
    expect(posture(graph).freezeExposure).toBe("unknown");
  });
  it("does not certify negative leaves through an unreviewed upgradeable receipt", () => {
    const graph = makeAccessGraph(); graph.authorities = [];
    graph.nodes.find((node) => node.nodeKey === "token")!.noCurrentReach = true;
    graph.nodes.find((node) => node.nodeKey === "receipt")!.noCurrentReach = false;
    const result = posture(graph);
    expect(result.freezeExposure).toBe("unknown");
    expect(result.freezeLookthrough!.unresolvedCoverageShare).toBe(0.4);
    expect(result.freezeLookthrough!.reviewedNoCurrentReachShare).toBe(0.6);
  });
  it("fails closed for cycles, overlap, disabled claims and malformed targets", () => {
    for (const mode of ["cycle", "overlap", "disabled"] as const) {
      const graph = makeAccessGraph();
      if (mode === "cycle") graph.edges.find((e) => e.edgeKey === "bridge-token")!.toNodeKey = "receipt";
      if (mode === "overlap") graph.partitions.find((p) => p.partitionKey === "root")!.disjoint = false;
      if (mode === "disabled") graph.edges[0]!.enabled = false;
      expect(evaluateV9AccessLookthrough(graph).coverageState).toBe("incomplete");
      expect(evaluateV9AccessLookthrough(graph).unresolvedCoverageShare).toBeNull();
    }
    const graph = makeAccessGraph(); graph.edges[0]!.toNodeKey = "absent";
    expect(() => resolveV9AccessClaimGraph(graph)).toThrow("Invalid edge target");
  });
  it("preserves originating issuer non-disclosure through transitive paths", () => {
    const graph = makeAccessGraph();
    graph.unresolved.push({ branchKey: "origin-disclosure", nodeKey: "token", reason: "issuer-undisclosed", responsibility: "issuer-undisclosed", status: requiredKnown("disclosure") });
    expect(evaluateV9AccessLookthrough(graph).unresolved).toContainEqual({ branchKey: "origin-disclosure", nodeKey: "token", reason: "issuer-undisclosed", responsibility: "issuer-undisclosed" });
    expect(evaluateV9AccessLookthrough(graph).unresolvedCoverageShare).toBeNull();
  });
  it("owns all display vocabulary in classification", () => {
    const policy = V9_CANDIDATE_POLICY_V1.policy.semantic.accessLookthrough;
    expect(Object.keys(ACCESS_LOOKTHROUGH_COVERAGE_LABELS).sort()).toEqual([...policy.coverageStates].sort());
    expect(Object.keys(ACCESS_LOOKTHROUGH_CAPABILITY_LABELS).sort()).toEqual([...policy.authorityCapabilities].sort());
    expect(Object.keys(ACCESS_LOOKTHROUGH_REASON_LABELS).sort()).toEqual([...policy.unresolvedReasons].sort());
  });
  it("binds graph vocabulary into the semantic digest without a new scoring decision", () => {
    const raw = structuredClone(V9_CANDIDATE_POLICY_V1.policy);
    raw.semantic.accessLookthrough.edgeKinds.reverse();
    expect(loadV9MethodologyPolicy(raw).semanticDigest).not.toBe(V9_CANDIDATE_POLICY_V1.semanticDigest);
    expect(raw.semantic.decisions.accessPostureScoring).toBe("categorical-unless-economic-loss-path");
  });
});
