import { describe, expect, it } from "vitest";
import { normalizeDeploymentId } from "@shared/types/deployment-id";
import { compareText, domainDigest } from "@shared/lib/safety-score-v9/primitives";
import type { MintAuthorityControl, MintAuthorityProfile } from "@shared/types/core";
import {
  V9AuthoredNegativeIncidentReviewSchema,
  V9NegativeIncidentReviewSchema,
} from "@shared/types/safety-score-v9-incidents";
import { buildSafetyScoreV9BaselineExtension } from "../safety-score-v9/extension";
import { routeSafetyScoreV9NegativeIncidentReviews } from "../safety-score-v9/extension-incidents";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension-shared";
import { compileSafetyScoreV9FactSetFromNormalizedInput } from "../safety-score-v9/fact-set";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { reviewedScope } from "@shared/lib/__tests__/safety-score-v9-control-scope.test-support";

const CLOCK = Date.parse("2026-10-07T14:00:00Z") / 1_000;
const ASSET_ID = "fixture-mint-authored";
const SOURCE = { label: "Fixture review", url: "https://example.com/review" };
const LABEL = "Fixture native minter";

function mintControl(overrides: Partial<MintAuthorityControl> = {}): MintAuthorityControl {
  return {
    chain: "arbitrum",
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    label: LABEL,
    role: "direct-minter",
    authorityType: "contract",
    directMintAbility: "direct",
    sources: [SOURCE],
    ...overrides,
  };
}

function mintProfile(overrides: Partial<MintAuthorityProfile> = {}): MintAuthorityProfile {
  return {
    mintPath: "issuer-direct-mint",
    authorityPosture: "partially-bounded-admin",
    confidence: "verified",
    summary: "The fixture has a reviewed native issuance authority.",
    controls: [mintControl()],
    review: {
      sources: [SOURCE],
      evidence: "The fixture review identifies the native issuance authority.",
      reviewer: "Fixture reviewer",
      reviewedAt: "2026-10-01",
      disposition: "unresolved",
    },
    ...overrides,
  };
}

function meta(overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return { id: ASSET_ID, mechanismArchetype: "fiat-cash", ...overrides };
}

function compileFixture(metadata: V9ExtensionRegistryMeta) {
  const fixed = makeV9FixedInput({ assetId: metadata.id, clockSec: CLOCK });
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[metadata.id, metadata]]),
  });
  const compiled = compileSafetyScoreV9FactSetFromNormalizedInput(normalizeFixedInput(fixed), extension);
  return { extension, compiled };
}

/** The documented `mint-meta:` digest payload, recomputed from the authored control. */
function mintControlKey(assetId: string, control: MintAuthorityControl): string {
  return `mint-meta:${assetId}:${domainDigest("safety-score-v9.mint-control-key.v1", {
    chain: control.chain ?? null,
    address: control.address?.toLowerCase() ?? null,
    label: control.label,
    role: control.role,
    authorityType: control.authorityType,
    directMintAbility: control.directMintAbility,
    deploymentRefs: [...(control.deploymentRefs ?? [])].map(normalizeDeploymentId).sort(compareText),
  }).slice(0, 20)}`;
}

function reviewPayload(scope: { kind: "control"; controlId: string } | { kind: "control"; controlKey: string }) {
  return {
    reviewId: `fixture-negative:${ASSET_ID}`,
    assetId: ASSET_ID,
    scope,
    reviewedAt: "2026-10-07T14:00:00Z",
    reviewer: "Fixture researcher",
    windowStartSec: Date.parse("2024-01-01T00:00:00Z") / 1_000,
    windowEndSec: CLOCK,
    conclusion: "no-known-incident",
    searchedSurfaces: [
      { kind: "issuer-status", url: "https://example.com/issuer-status", finding: "Issuer status and announcements searched for this asset and chain; no known control incident." },
      { kind: "explorer-events", url: "https://example.com/explorer-events", finding: "Exact deployment's displayed events tab shows no Pause/EmergencyStop events; paused()=false at pinned block 123 with timestamp 2026-10-07T13:00:00Z." },
      { kind: "incident-tracker", url: "https://example.com/incident-tracker", finding: "DefiLlama hacks, rekt.news and rail-provider security disclosures searched by issuer, asset, rail and chain; no known affected control." },
    ],
    sources: [
      { label: "Primary status", url: "https://example.com/issuer-status", observedAt: "2026-10-07T14:00:00Z", location: "Status archive", excerpt: "Operational" },
      { label: "Exact explorer and pinned emergency read", url: "https://example.com/explorer-events", observedAt: "2026-10-07T14:00:00Z", location: "Creation timestamp 2024-01-01; events tab; block 123", excerpt: "No displayed emergency event; paused=false." },
      { label: "Incident and rail searches", url: "https://example.com/incident-tracker", observedAt: "2026-10-07T14:00:00Z", location: "Issuer/asset/rail/chain search results", excerpt: "No known affected control found." },
    ],
  };
}

describe("Safety Score v9 authored mint-control identity (IR-1d)", () => {
  it("carries the authored label into the compiled control fact and leaves the digest key unchanged", () => {
    const control = mintControl();
    const { compiled } = compileFixture(meta({ mintAuthority: mintProfile({ controls: [control] }) }));
    const asset = compiled.assets[0]!;
    expect(asset.controls).toHaveLength(1);
    const fact = asset.controls[0]!;
    expect(fact.authoredControlId).toBe(LABEL);
    expect(fact).not.toHaveProperty("authoredControlIds");
    expect(fact.deploymentKey).toBe(`asset:${ASSET_ID}`);
    // The digest payload is the pre-IR-1d payload: recompute it and compare.
    expect(fact.controlKey).toBe(mintControlKey(ASSET_ID, control));
    // Gap ids still embed `controlKey` only, and never the authored label.
    const wholeControlGap = `${ASSET_ID}:gap:deployment-control:${fact.controlKey}`;
    const incidentGap = `${ASSET_ID}:gap:control:${fact.controlKey}:incidentState`;
    expect(fact.status.gapIds).toEqual([wholeControlGap]);
    expect(fact.factorStatuses?.incidentState?.gapIds).toEqual([incidentGap]);
    expect(asset.gaps.map((gap) => gap.gapId).filter((gapId) => gapId.includes("mint"))).toEqual(
      expect.arrayContaining([wholeControlGap, incidentGap]),
    );
    expect(asset.gaps.some((gap) => gap.gapId.includes(LABEL))).toBe(false);
  });

  it("propagates the authored label onto every derived execution-path row", () => {
    const control = mintControl();
    const scope = reviewedScope({
      controllerDeployment: `${control.chain}:${control.address}`,
      inventory: "complete",
      confidence: "verified",
    });
    const { compiled } = compileFixture(meta({
      mintAuthority: mintProfile({ controls: [{ ...control, executionScope: scope }] }),
    }));
    const asset = compiled.assets[0]!;
    expect(asset.controls).toHaveLength(1);
    const fact = asset.controls[0]!;
    // The digest key keeps its documented `:path:<id>` suffix; only the
    // authored carrier is added, so the base digest recomputes unchanged.
    expect(fact.controlKey).toBe(`${mintControlKey(ASSET_ID, control)}:path:${scope.paths[0]!.id}`);
    expect(fact.deploymentKey).toBe(`asset:${ASSET_ID}`);
    expect(fact.authoredControlId).toBe(LABEL);
    const authoredReview = V9AuthoredNegativeIncidentReviewSchema.parse(
      reviewPayload({ kind: "control", controlId: LABEL }),
    );
    expect(routeSafetyScoreV9NegativeIncidentReviews(asset.controls, ASSET_ID, CLOCK, [authoredReview], [])[0]!.incidentState).toBe("none");
  });

  it("keeps the authored identity while the digest churns, and resolves one review onto both facts", () => {
    const correctedAddress = "0xcccccccccccccccccccccccccccccccccccccccc";
    const original = compileFixture(meta({ mintAuthority: mintProfile() })).compiled.assets[0]!;
    const reKeyed = compileFixture(meta({
      mintAuthority: mintProfile({ controls: [mintControl({ address: correctedAddress })] }),
    })).compiled.assets[0]!;
    const originalFact = original.controls[0]!;
    const reKeyedFact = reKeyed.controls[0]!;

    // An address correction re-derives the digest key...
    expect(originalFact.controlKey).toBe(mintControlKey(ASSET_ID, mintControl()));
    expect(reKeyedFact.controlKey).toBe(mintControlKey(ASSET_ID, mintControl({ address: correctedAddress })));
    expect(reKeyedFact.controlKey).not.toBe(originalFact.controlKey);
    // ...but the authored identity, and therefore the review, survives it.
    expect(originalFact.authoredControlId).toBe(LABEL);
    expect(reKeyedFact.authoredControlId).toBe(LABEL);
    expect(reKeyedFact.factorStatuses?.incidentState?.gapIds).toEqual([
      `${ASSET_ID}:gap:control:${reKeyedFact.controlKey}:incidentState`,
    ]);

    const authoredReview = V9AuthoredNegativeIncidentReviewSchema.parse(
      reviewPayload({ kind: "control", controlId: LABEL }),
    );
    const routedOriginal = routeSafetyScoreV9NegativeIncidentReviews(original.controls, ASSET_ID, CLOCK, [authoredReview], []);
    const routedReKeyed = routeSafetyScoreV9NegativeIncidentReviews(reKeyed.controls, ASSET_ID, CLOCK, [authoredReview], []);
    expect(originalFact.incidentState).toBe("unknown");
    expect(routedOriginal[0]!.incidentState).toBe("none");
    expect(routedReKeyed[0]!.incidentState).toBe("none");

    // Legacy digest rows keep exact-key matching: the pre-churn key closes only
    // the fact it names, so today's digest data resolves exactly as before.
    const digestReview = V9NegativeIncidentReviewSchema.parse(
      reviewPayload({ kind: "control", controlKey: originalFact.controlKey }),
    );
    expect(routeSafetyScoreV9NegativeIncidentReviews(original.controls, ASSET_ID, CLOCK, [digestReview], [])[0]!.incidentState).toBe("none");
    expect(routeSafetyScoreV9NegativeIncidentReviews(reKeyed.controls, ASSET_ID, CLOCK, [digestReview], [])[0]!.incidentState).toBe("unknown");
  });
});
