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
    }];
    render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    const roles = screen.getByRole("region", { name: "Scored role dependencies (not drawn)" });
    expect(within(roles).getByRole("link", { name: "USDC" }).getAttribute("href")).toBe("/stablecoin/usdc-circle");
    expect(roles.textContent).toContain("Exit dependency");
    expect(roles.textContent).toContain("25%");
    expect(screen.getByRole("region", { name: "What depends on me" }).textContent).toContain("0 direct dependents");
    expect(roles.textContent).toContain("Role score 84/100");
    expect(screen.getByRole("region", { name: "What I depend on" }).textContent).toContain("No upstream links");
  });

  it("distinguishes unpublished coverage from a published empty list", () => {
    const card = makeV9Card();
    delete card.dependencyCoverage;
    const { rerender } = render(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    const region = () => screen.getByRole("region", { name: "Known, not in the scored graph" });
    expect(region().textContent).toContain("not published for this generation");
    card.dependencyCoverage = [];
    rerender(<DependencyContextDetails card={card} context={EMPTY_CONTEXT} marketCapAsOf={null} />);
    expect(region().textContent).toContain("No known relationships outside the scored graph published");
    expect(region().textContent).not.toContain("not published for this generation");
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
    expect(screen.getByRole("region", { name: "What depends on me" }).textContent).toContain("0 direct dependents");
  });
});
