import type { ExitRouteObservation } from "@shared/types/exit-route";
import type { V9EvidenceLevel, V9StructuralSignal, V9UnresolvedFact } from "@shared/types/safety-score-v9";

const OBSERVED_AT = 1_780_000_000;

function dexRoute(overrides: Partial<ExitRouteObservation> = {}): ExitRouteObservation {
  return {
    routeId: "dex:strong",
    routeFamily: "dex-amm",
    scope: { kind: "protocol", protocol: "matched-corpus", chain: "ethereum" },
    requestedNotionalUsd: 1_000_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 1_000_000,
    completionRatio: 1,
    output: { kind: "fiat", currency: "USD" },
    evidenceKind: "measured-executable-depth",
    confidence: "high",
    scoreEligible: true,
    observedAt: OBSERVED_AT,
    freshnessSeconds: 0,
    commonModeKeys: ["protocol:matched-corpus"],
    ...overrides,
  };
}

function redemptionRoute(overrides: Partial<ExitRouteObservation> = {}): ExitRouteObservation {
  return dexRoute({
    routeId: "redemption:issuer",
    routeFamily: "issuer-redemption",
    scope: { kind: "issuer", issuerId: "matched-issuer" },
    evidenceKind: "documented-terms",
    commonModeKeys: ["issuer:matched"],
    ...overrides,
  });
}

const dependencyWeakSignal: V9StructuralSignal = {
  kind: "critical-dependency",
  severity: "high",
  reason: "A material required dependency is weak.",
  materialSharePct: 40,
  failureDomainKeys: ["dependency:matched"],
  evidence: [],
};

const dependencyUnavailable: V9UnresolvedFact = {
  code: "material-dependency-unavailable",
  reason: "A material required dependency is unavailable.",
  critical: false,
  path: "dependencies",
  responsibility: "integration-missing",
};

const weakOracleBranch: V9StructuralSignal = {
  kind: "weak-oracle-branch",
  severity: "high",
  reason: "A liquidation branch depends on a weak oracle path.",
  failureDomainKeys: ["oracle:shared"],
  evidence: [],
};

export const MATCHED_V9_INVARIANTS = [
  {
    id: "redemption-present",
    kind: "exit-routes",
    rationale: "A credible common-request redemption route must improve thin DEX exit.",
    before: [dexRoute({ executableUsd: 200_000, completionRatio: 0.2 })],
    after: [dexRoute({ executableUsd: 200_000, completionRatio: 0.2 }), redemptionRoute()],
  },
  {
    id: "weak-optional-route",
    kind: "exit-routes",
    rationale: "Adding a weak optional route cannot reduce the selected strong route.",
    before: [dexRoute()],
    after: [dexRoute(), redemptionRoute({ routeId: "redemption:weak", executableUsd: 50_000, completionRatio: 0.05 })],
  },
  {
    id: "reserve-loss-materiality",
    kind: "reserve-loss",
    rationale: "Greater unabsorbed loss-bearing reserve exposure cannot score better.",
    before: { exposurePct: 15, lossAbsorptionPct: 50, failureDomainKey: "reserve:matched" },
    after: { exposurePct: 35, lossAbsorptionPct: 10, failureDomainKey: "reserve:matched" },
  },
  {
    id: "bridge-materiality",
    kind: "structural-signals",
    rationale: "A peripheral route must not bind like a material route.",
    before: [
      {
        kind: "material-bridge",
        severity: "high",
        reason: "A reviewed bridge route is peripheral.",
        materialSharePct: 2,
        failureDomainKeys: ["bridge:matched"],
        evidence: [],
      },
    ] satisfies V9StructuralSignal[],
    after: [
      {
        kind: "material-bridge",
        severity: "high",
        reason: "A reviewed bridge route is material.",
        materialSharePct: 30,
        failureDomainKeys: ["bridge:matched"],
        evidence: [],
      },
    ] satisfies V9StructuralSignal[],
  },
  {
    id: "dependency-availability",
    kind: "scoring-facts",
    rationale: "Strong, weak, and unavailable required dependencies must remain distinguishable.",
    variants: {
      absent: { structuralSignals: [], unresolved: [] },
      strong: { structuralSignals: [], unresolved: [] },
      weak: { structuralSignals: [dependencyWeakSignal], unresolved: [] },
      unavailable: { structuralSignals: [dependencyWeakSignal], unresolved: [dependencyUnavailable] },
    },
  },
  {
    id: "oracle-common-mode",
    kind: "structural-signals",
    rationale: "Shared weak oracle domains must bind below isolated branch weakness.",
    before: [weakOracleBranch],
    after: [weakOracleBranch, { ...weakOracleBranch, reason: "A second branch shares the weak oracle path." }],
  },
  {
    id: "evidence-criticality",
    kind: "evidence-facts",
    rationale: "Complete, bounded, noncritical-missing, and critical-missing evidence remain distinct.",
    variants: {
      complete: { evidenceLevel: "strong", structuralSignals: [], unresolved: [] },
      boundedUnknown: {
        evidenceLevel: "adequate",
        structuralSignals: [],
        unresolved: [],
      },
      noncriticalMissing: {
        evidenceLevel: "limited",
        structuralSignals: [],
        unresolved: [
          {
            code: "bounded-unknown-reserve-exposure",
            reason: "A noncritical fact is missing.",
            critical: false,
            responsibility: "integration-missing",
          },
        ],
      },
      criticalMissing: {
        evidenceLevel: "insufficient",
        structuralSignals: [],
        unresolved: [{
          code: "insufficient-evidence",
          reason: "A critical fact is missing.",
          critical: true,
          responsibility: "integration-missing",
        }],
      },
    } satisfies Record<
      string,
      {
        evidenceLevel: V9EvidenceLevel;
        structuralSignals: V9StructuralSignal[];
        unresolved: V9UnresolvedFact[];
      }
    >,
  },
  {
    id: "parent-propagation",
    kind: "parent-graph",
    rationale: "A required child cannot rate above or without its parent.",
    parent: { assetId: "matched-parent", pillarScore: 55 },
    child: { assetId: "matched-child", pillarScore: 90 },
  },
] as const;

export type MatchedV9Invariant = (typeof MATCHED_V9_INVARIANTS)[number];
