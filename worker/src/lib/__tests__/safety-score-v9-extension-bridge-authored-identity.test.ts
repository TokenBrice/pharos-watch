import { describe, expect, it } from "vitest";
import { domainDigest } from "@shared/lib/safety-score-v9/primitives";
import { ReviewEvidenceBuilder } from "@shared/lib/safety-score-v9/review-evidence";
import type { BridgeRouteControl, BridgeRouteDeployment, BridgeRouteRiskProfile } from "@shared/types/core";
import { V9NegativeIncidentReviewSchema } from "@shared/types/safety-score-v9-incidents";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { adaptBridgeReview } from "../safety-score-v9/extension-bridge";
import { routeSafetyScoreV9NegativeIncidentReviews } from "../safety-score-v9/extension-incidents";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

const CLOCK = Date.parse("2026-10-07T14:00:00Z") / 1_000;
const SOURCE = { label: "Fixture review", url: "https://example.com/review" };
const BASE_ROUTE = "base:0x3333333333333333333333333333333333333333";
const ASSET_ID = "fixture-authored-bridge";

function route(id: string, overrides: Partial<BridgeRouteDeployment> = {}): BridgeRouteDeployment {
  const separator = id.indexOf(":");
  const chain = id.slice(0, separator);
  return {
    id,
    destinationChain: chain,
    contractAddress: id.slice(separator + 1),
    protocol: "Fixture transfer rail",
    issuanceModel: "native-issuance",
    routeClass: "native",
    riskTier: "single-chain-or-native",
    semantics: "native-mint",
    scope: "canonical",
    reviewDisposition: "reviewed",
    observedAt: "2026-10-01",
    sources: [SOURCE],
    ...overrides,
  };
}

function bridgeControl(overrides: Partial<BridgeRouteControl> = {}): BridgeRouteControl {
  return {
    id: "fixture-bridge-control",
    label: "Fixture structured bridge controller",
    routeRefs: [BASE_ROUTE],
    capabilities: ["bridge-mint"],
    controllerChain: "base",
    controllerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    authorityType: "contract",
    sources: [SOURCE],
    ...overrides,
  };
}

function bridgeProfile(
  routes: BridgeRouteDeployment[],
  overrides: Partial<BridgeRouteRiskProfile> = {},
): BridgeRouteRiskProfile {
  return {
    tier: "issuer-native-burn-mint",
    summary: "The fixture has reviewed native and transfer-rail deployments.",
    reviewedAt: "2026-10-01",
    reviewer: "Fixture reviewer",
    confidence: "verified",
    sources: [SOURCE],
    routes,
    ...overrides,
  };
}

function meta(overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return { id: ASSET_ID, mechanismArchetype: "fiat-cash", ...overrides };
}

function supplyByRoute(routes: readonly BridgeRouteDeployment[]) {
  return Object.fromEntries(
    [...new Set(routes.map((candidate) => candidate.destinationChain))].map((chain) => [
      chain,
      { current: 10_000_000, circulatingPrevDay: 10_000_000, circulatingPrevWeek: 10_000_000, circulatingPrevMonth: 10_000_000 },
    ]),
  );
}

function compileFixture(metadata: V9ExtensionRegistryMeta) {
  const routes = metadata.bridgeRouteRisk?.routes ?? [];
  const fixed = makeV9FixedInput({
    assetId: metadata.id,
    clockSec: CLOCK,
    chainSupplyByChain: supplyByRoute(routes),
  });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[metadata.id, metadata]]),
  });
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(fixed), extension);
  return { extension, compiled };
}

function adapt(metadata: V9ExtensionRegistryMeta, supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> | null = null) {
  return adaptBridgeReview(metadata, supplyReview, 2, new ReviewEvidenceBuilder(metadata.id, CLOCK), CLOCK);
}

function laneControlKey(controlIds: string[]): string {
  return `bridge-meta:${ASSET_ID}:${domainDigest(
    "safety-score-v9.structured-bridge-route-control-key.v1",
    { controlIds: [...controlIds].sort(), routeId: BASE_ROUTE },
  ).slice(0, 20)}`;
}

const NEGATIVE_REVIEW = V9NegativeIncidentReviewSchema.parse({
  reviewId: "fixture-negative-authored-identity",
  assetId: ASSET_ID,
  scope: { kind: "control", controlKey: "mint-meta:fixture-authored-bridge:controller" },
  reviewedAt: "2026-10-07T14:00:00Z",
  reviewer: "Fixture researcher",
  windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000,
  windowEndSec: CLOCK,
  conclusion: "no-known-incident",
  searchedSurfaces: [
    { kind: "issuer-status", url: "https://example.com/issuer-status", finding: "Issuer status and announcements searched for this asset and chain; no known control incident." },
    { kind: "explorer-events", url: "https://example.com/explorer-events", finding: "Exact deployment's displayed events tab shows no Pause/EmergencyStop events; paused()=false at pinned block 123 with timestamp 2026-10-07T13:00:00Z. Displayed tab is bounded, not a lifetime log census." },
    { kind: "incident-tracker", url: "https://example.com/incident-tracker", finding: "DefiLlama hacks, rekt.news and rail-provider security disclosures searched by issuer, asset, rail and chain; no known affected control." },
  ],
  sources: [
    { label: "Primary status", url: "https://example.com/issuer-status", observedAt: "2026-10-07T14:00:00Z", location: "Status archive", excerpt: "Operational" },
    { label: "Exact explorer and pinned emergency read", url: "https://example.com/explorer-events", observedAt: "2026-10-07T14:00:00Z", location: "Creation timestamp 2024-01-01; events tab; block 123", excerpt: "No displayed emergency event; paused=false." },
    { label: "Incident and rail searches", url: "https://example.com/incident-tracker", observedAt: "2026-10-07T14:00:00Z", location: "Issuer/asset/rail/chain search results", excerpt: "No known affected control found." },
  ],
});

describe("Safety Score v9 authored bridge-control identity", () => {
  it("keys a single-control lane by its authored id without touching the digest control key", () => {
    const metadata = meta({ bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE)], { controls: [bridgeControl()] }) });
    const adapted = adapt(metadata);
    expect(adapted.controls).toHaveLength(1);
    const control = adapted.controls[0]!;
    expect(control.authoredControlId).toBe("fixture-bridge-control");
    expect(control).not.toHaveProperty("authoredControlIds");
    expect(control.deploymentKey).toBe(BASE_ROUTE);
    // Gap ids embed `controlKey`; the aggregate digest payload and truncation are unchanged.
    expect(control.controlKey).toBe(laneControlKey(["fixture-bridge-control"]));
  });

  it("keys a merged lane by `*` and publishes the canonical contributor set", () => {
    const metadata = meta({
      bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE)], {
        controls: [
          bridgeControl({ id: "fixture-zeta-control" }),
          bridgeControl({ id: "fixture-alpha-control", controllerAddress: "0xcccccccccccccccccccccccccccccccccccccccc" }),
        ],
      }),
    });
    const control = adapt(metadata).controls[0]!;
    expect(control.authoredControlId).toBe("*");
    expect(control.authoredControlIds).toEqual(["fixture-alpha-control", "fixture-zeta-control"]);
    // A merged lane's digest covers the contributor set, never one control.
    expect(control.controlKey).not.toBe(laneControlKey(["fixture-alpha-control"]));
    expect(control.controlKey).toBe(laneControlKey(["fixture-alpha-control", "fixture-zeta-control"]));
  });

  it("leaves digest-only control forms without authored identity", () => {
    const fallback = adapt(meta({ bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE, {
      issuanceModel: "bridge-representation",
      routeClass: "third-party",
      riskTier: "external-lock-mint",
      semantics: "lock-mint",
      scope: "peripheral",
    })]) })).controls[0]!;
    expect(fallback.controlKey.startsWith("bridge-meta:")).toBe(true);
    expect(fallback.authoredControlId).toBeUndefined();
    expect(fallback.authoredControlIds).toBeUndefined();

    const supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> = {
      selectedBridgeRoutes: [{
        deploymentRouteKey: "unmatched-chain:fixture:producer-uuid-a",
        supplyUsd: 2_000_000,
        supplyShare: 0.2,
        reviewState: "unmatched",
      }],
      selectedRouteSupplyShare: 0,
      unknownRouteSupplyShare: 0.2,
      unreviewedRouteSupplyShare: 0,
      failureDomains: [],
    };
    const supplyControl = adapt(meta({ bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE)]) }), supplyReview)
      .controls.find((control) => control.controlKey.startsWith("bridge-supply:"));
    expect(supplyControl).toBeDefined();
    expect(supplyControl!.authoredControlId).toBeUndefined();
    expect(supplyControl!.authoredControlIds).toBeUndefined();
  });

  it("keeps authored ids stable across producer supply-key churn and compiles gap ids unchanged", () => {
    const build = (producerRouteKey: string) => {
      const metadata = meta({
        bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE)], { controls: [bridgeControl()] }),
      });
      const supplyReview: NonNullable<Parameters<typeof adaptBridgeReview>[1]> = {
        selectedBridgeRoutes: [{
          deploymentRouteKey: producerRouteKey,
          supplyUsd: 2_000_000,
          supplyShare: 0.2,
          reviewState: "unmatched",
        }],
        selectedRouteSupplyShare: 0,
        unknownRouteSupplyShare: 0.2,
        unreviewedRouteSupplyShare: 0,
        failureDomains: [],
      };
      const adapted = adapt(metadata, supplyReview);
      const { compiled } = compileFixture(metadata);
      return {
        adapted: adapted.controls.find((control) => control.controlKey.startsWith("bridge-meta:"))!,
        producer: adapted.controls.find((control) => control.controlKey.startsWith("bridge-supply:"))!,
        gaps: compiled.assets[0]!.gaps.map((gap) => gap.gapId),
      };
    };
    const first = build("unmatched-chain:fixture:producer-uuid-a");
    const second = build("unmatched-chain:fixture:producer-uuid-b");
    // The producer recomputation changes digest identity for its own row...
    expect(first.producer.controlKey).not.toBe(second.producer.controlKey);
    // ...while the authored tuple and every compiled gap id stay identical.
    expect(first.adapted.authoredControlId).toBe("fixture-bridge-control");
    expect(second.adapted.authoredControlId).toBe("fixture-bridge-control");
    expect(first.adapted.controlKey).toBe(second.adapted.controlKey);
    expect(first.gaps).toEqual(second.gaps);
    expect(first.gaps.some((gapId) => gapId.includes("fixture-bridge-control"))).toBe(false);
  });

  it("keeps negative incident review matching keyed on the digest control key", () => {
    const { compiled } = compileFixture(meta({ bridgeRouteRisk: bridgeProfile([route(BASE_ROUTE)], { controls: [bridgeControl()] }) }));
    const control = compiled.assets[0]!.controls.find((row) => row.controlKey.startsWith(`bridge-meta:${ASSET_ID}:`))!;
    expect(control.authoredControlId).toBe("fixture-bridge-control");
    const exact = V9NegativeIncidentReviewSchema.parse({ ...NEGATIVE_REVIEW, scope: { kind: "control", controlKey: control.controlKey } });
    expect(routeSafetyScoreV9NegativeIncidentReviews([control], ASSET_ID, CLOCK, [exact], [])[0]!.incidentState).toBe("none");
    // A review naming the authored tuple is not the digest key and matches nothing.
    const authored = {
      ...NEGATIVE_REVIEW,
      reviewId: "fixture-negative-authored-id",
      scope: { kind: "control" as const, controlKey: `${ASSET_ID}:${BASE_ROUTE}:fixture-bridge-control` },
    };
    expect(routeSafetyScoreV9NegativeIncidentReviews([control], ASSET_ID, CLOCK, [authored], [])[0]!.incidentState).toBe("unknown");
  });
});
