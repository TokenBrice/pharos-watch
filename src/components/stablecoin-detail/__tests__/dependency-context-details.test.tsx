// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { DependencyContextDetails } from "../dependency-context-details";
import type { DetailDependencyContext } from "../dependency-context-model";

const EMPTY_CONTEXT: DetailDependencyContext = { exposure: undefined, upstreams: [] };

describe("DependencyContextDetails", () => {
  it("shows scored roles independently of serial and basket graph links", () => {
    const card = makeV9Card();
    card.dependencies.roles = [{
      edgeKey: "exit-usdc", exposureKey: "exit", riskEventKey: "exit-event",
      upstreamAssetId: "usdc-circle", role: "exit-dependency", weight: 0.25,
      targetPillar: "exit", propagationEventEdgeKeys: [],
      propagationEventExposureKey: null, propagationEventRiskEventKey: null,
      propagationEventNominalExposureShare: null, propagationEventExposureShare: null,
      propagationEventInheritedScore: null, propagationEventModeledLossPoints: null,
      inheritedDimensions: ["exit"], unavailableDimensions: [], score: 84,
      boundedUnknown: false, cycleBlocked: false, evidenceRefIds: [], failureDomains: [],
      ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [],
    }];
    render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    const roles = screen.getByRole("region", { name: "Scored role dependencies (not drawn)" });
    expect(within(roles).getByRole("link", { name: "USDC" }).getAttribute("href")).toBe("/stablecoin/usdc-circle");
    expect(roles.textContent).toContain("Exit dependency");
    expect(roles.textContent).toContain("25%");
    expect(screen.queryByRole("region", { name: "What depends on me" })).toBeNull();
    expect(roles.textContent).toContain("Role score 84/100");
    expect(screen.queryByRole("region", { name: "What I depend on" })).toBeNull();
  });

  it("rounds published role scores for display", () => {
    const card = makeV9Card();
    card.dependencies.roles = [{
      edgeKey: "exit-usdc", exposureKey: "exit", riskEventKey: "exit-event",
      upstreamAssetId: "usdc-circle", role: "exit-dependency", weight: 0.25,
      targetPillar: "exit", propagationEventEdgeKeys: [],
      propagationEventExposureKey: null, propagationEventRiskEventKey: null,
      propagationEventNominalExposureShare: null, propagationEventExposureShare: null,
      propagationEventInheritedScore: null, propagationEventModeledLossPoints: null,
      inheritedDimensions: ["exit"], unavailableDimensions: [], score: 81.687572,
      boundedUnknown: false, cycleBlocked: false, evidenceRefIds: [], failureDomains: [],
      ratingStatus: "rated", partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [],
    }];
    render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    const roles = screen.getByRole("region", { name: "Scored role dependencies (not drawn)" });
    expect(roles.textContent).toContain("Role score 82/100");
  });

  it("tags upstream links once per relationship group and previews five", () => {
    const upstreams = Array.from({ length: 7 }, (_, index) => ({
      coin: { id: `coin-${index}`, symbol: `C${index}` },
      edgeType: "basket", relationshipType: "collateral", weight: 0.1,
    })) as unknown as DetailDependencyContext["upstreams"];
    render(<DependencyContextDetails card={makeV9Card()} context={{ exposure: undefined, upstreams }} marketCapAsOf={null} />);
    const region = screen.getByRole("region", { name: "What I depend on" });
    expect(within(region).getAllByText(/^Collateral \(basket\)/)).toHaveLength(1);
    expect(within(region).getAllByRole("link")).toHaveLength(5);
    expect(within(region).getByRole("button", { name: /Show all 7/ })).toBeTruthy();
  });

  it.each(["empty", "unpublished"] as const)("collapses all %s quadrants into one line without empty blocks", (state) => {
    const card = makeV9Card({ dependencyCoverage: [] });
    card.dependencies.roles = [];
    if (state === "unpublished") {
      delete card.dependencyCoverage;
      delete card.dependencies.roles;
    }
    const { container } = render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelectorAll("h3")).toHaveLength(0);
  });

  it("discloses coverage shares and reasons without linking unverified identities or adding exposure", () => {
    const card = makeV9Card({ dependencyCoverage: [
      { upstreamLabel: "USDC", upstreamAssetId: "usdc-circle", share: 0.12,
        reason: "stale-evidence", sourceAsOf: "2026-08-31", identityVerified: true },
      { upstreamLabel: "Unverified bridge claim", upstreamAssetId: null, share: null,
        reason: "identity-unverified", sourceAsOf: null, identityVerified: false },
    ] });
    render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    const coverage = screen.getByRole("region", { name: "Known, not in the scored graph" });
    expect(within(coverage).getByRole("link", { name: "USDC" })).toBeTruthy();
    expect(within(coverage).queryByRole("link", { name: "Unverified bridge claim" })).toBeNull();
    expect(coverage.textContent).toContain("12%");
    expect(coverage.textContent).toContain("stale-evidence");
    expect(coverage.textContent).toContain("2026-08-31");
    expect(coverage.textContent).toContain("Share unknown");
    expect(coverage.textContent).toContain("Identity unverified");
    expect(screen.queryByRole("region", { name: "What depends on me" })).toBeNull();
  });
});
