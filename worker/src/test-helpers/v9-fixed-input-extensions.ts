import { computeReportCardsRegistryFingerprint } from "../lib/report-cards-fixed-input";
import type { SafetyScoreV9FactSetExtensionV2 } from "../lib/safety-score-v9/fact-set";
import {
  V9_FIXTURE_OBSERVED_AT_SEC,
  V9_FIXTURE_CLOCK_SEC,
} from "./v9-fixed-input-observations";
import {
  v9NotApplicableStatus,
  v9RouteReview,
  v9Status,
} from "./v9-fixed-input-core";

/** A strong three-component fiat-cash mechanism review. */
function v9MechanismReview() {
  const component = {
    status: v9Status(),
    quality: "strong" as const,
    failureDomains: [{ kind: "reserve-issuer" as const, key: "issuer:alpha" }],
  };
  return {
    archetype: "fiat-cash" as const,
    claimAndSegregation: component,
    custodyContinuity: component,
    assuranceAndReconciliation: component,
  };
}
// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

/** The reviewed V2 extension that pairs with `makeV9FixedInput()`. */
export function makeV9Extension(
  options: {
    assetId?: string;
    clockSec?: number;
    observedAtSec?: number;
    registryFingerprint?: string;
  } = {},
): SafetyScoreV9FactSetExtensionV2 {
  const assetId = options.assetId ?? "alpha";
  const clockSec = options.clockSec ?? V9_FIXTURE_CLOCK_SEC;
  const observedAtSec = options.observedAtSec ?? clockSec - 100;
  return {
    schemaVersion: 2,
    registryFingerprint: options.registryFingerprint ?? computeReportCardsRegistryFingerprint(),
    compiledAtSec: clockSec + 1,
    sources: {
      registryObservedAtSec: observedAtSec,
      unavailableRedemptionObservedAtSec: observedAtSec,
      liveReserves: { generationId: "reserves:fixture-v1", observedAtSec, maxAgeSec: 500 },
      chainSupply: { generationId: "supply:fixture-v1", observedAtSec, maxAgeSec: 500 },
      peg: { generationId: "peg:fixture-v1", observedAtSec, maxAgeSec: 500 },
      researchOverlays: { generationId: "research:fixture-v1", observedAtSec, maxAgeSec: 500 },
    },
    routeFreshness: { dexMaxAgeSec: 500, redemptionMaxAgeSec: 500, documentedTermsMaxAgeSec: 31_536_000 },
    assets: [
      {
        assetId,
        archetype: "fiat-cash",
        launchedAtSec: 1_000,
        mechanismRiskReview: v9MechanismReview(),
        dependencies: {
          source: "none",
          baseSource: "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges: [],
          diagnostics: { graphState: "valid", issueCodes: [], sccMemberAssetIds: [] },
        },
        reserveApplicability: { state: "required" },
        reserveClassifications: [],
        routeReviews: [v9RouteReview("dex:primary", observedAtSec)],
        retainedRoutes: [],
        controlReview: {
          state: "no-privileged-controls",
          rationale: "The reviewed fixture implementation has no privileged deployment controls.",
        },
        economicControlReview: {
          mint: {
            status: v9NotApplicableStatus("v9.control.mint-review"),
            controlKey: null,
            reconciliation: "not-applicable",
            supervision: "unknown",
            latestResolvedIncidentAtSec: null,
            upgrade: { state: "not-applicable", controlKey: null },
          },
          oracle: {
            status: v9NotApplicableStatus("v9.control.oracle-review"),
            tier: null,
            branches: [],
          },
          bridge: {
            status: v9NotApplicableStatus("v9.control.bridge-review"),
            routes: [],
          },
        },
        accessReview: {
          transfer: { status: v9Status("known", "v9.access.transfer-review"), posture: "permissionless" },
          freeze: {
            status: v9Status("known", "v9.access.freeze-review"),
            reviews: [
              {
                reviewKey: "freeze:none-reviewed",
                source: "blacklist",
                status: v9Status("known", "v9.access.freeze-review"),
                reach: "none",
                controlKey: null,
                upstreamAssetId: null,
                failureDomains: [],
              },
            ],
          },
        },
        pegReference: {
          referenceKind: "fiat",
          referenceKey: "USD",
          failureDomains: [{ kind: "oracle-feed", key: "fixture-price" }],
        },
        supplyReview: {
          selectedBridgeRoutes: [],
          selectedRouteSupplyShare: 0,
          // Single-chain native with no route rows conserves to unknown=1 (VER-007).
          unknownRouteSupplyShare: 1,
          unreviewedRouteSupplyShare: 0,
          failureDomains: [],
        },
        researchEvidence: [],
        componentEvidence: [],
      },
    ],
  };
}

export type V9ExtensionDependencyEdge = NonNullable<
  SafetyScoreV9FactSetExtensionV2["assets"][number]["dependencies"]
>["edges"][number];

/** Fan `makeV9Extension()` across a multi-asset capture, wiring reviewed roles. */
export function makeV9RoleExtension(
  fixed: { registryFingerprint: string; activeAssetIds: readonly string[] },
  edgesByAssetId: Readonly<Record<string, readonly V9ExtensionDependencyEdge[]>>,
  observedAtSec = V9_FIXTURE_OBSERVED_AT_SEC,
): SafetyScoreV9FactSetExtensionV2 {
  const base = makeV9Extension();
  return {
    ...base,
    registryFingerprint: fixed.registryFingerprint,
    assets: fixed.activeAssetIds.map((assetId) => {
      const asset = structuredClone(base.assets[0]!);
      const edges = [...(edgesByAssetId[assetId] ?? [])];
      const hasDependencyEvidence = edges.length > 0;
      return {
        ...asset,
        assetId,
        dependencies: {
          source: edges.length > 0 ? "manual" : "none",
          baseSource: edges.length > 0 ? "manual" : "none",
          dependencyFromLive: false,
          mappedLiveReserveWeight: null,
          fallbackReason: null,
          edges,
          diagnostics: {
            graphState: "valid",
            issueCodes: [],
            sccMemberAssetIds: [],
          },
        },
        routeReviews: [v9RouteReview(assetId === "alpha" ? "dex:primary" : `dex:${assetId}`)],
        researchEvidence: hasDependencyEvidence
          ? [
              {
                evidenceKey: `dependencies:${assetId}`,
                sourceId: "fixture.role-dependencies",
                observedAtSec,
                publishedAtSec: null,
                url: `https://example.com/dependencies/${assetId}`,
                contentSha256: "d".repeat(64),
                confidence: "manual-review",
                maxAgeSec: 500,
              },
            ]
          : [],
        componentEvidence: hasDependencyEvidence
          ? [{ componentKey: "dependencies", evidenceKeys: [`dependencies:${assetId}`] }]
          : [],
      };
    }),
  };
}

/** A reviewed dependency edge carrying one economic role. */
export function v9ExtensionRoleEdge(
  upstreamAssetId: string,
  economicRole: "exit-dependency" | "control-operator" | "oracle-nav",
  weight = 1,
): V9ExtensionDependencyEdge {
  const domain =
    economicRole === "exit-dependency"
      ? { kind: "redemption-rail" as const, key: `rail:${upstreamAssetId}` }
      : economicRole === "control-operator"
        ? { kind: "mint-control" as const, key: `operator:${upstreamAssetId}` }
        : { kind: "oracle-feed" as const, key: `oracle:${upstreamAssetId}` };
  return {
    upstreamAssetId,
    dependencyType: "mechanism",
    economicRole,
    weight,
    failureDomains: [domain],
  };
}
