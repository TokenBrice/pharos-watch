// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { DependencyContextDetails } from "../dependency-context-details";
import { buildDetailDependencyContext, type DetailDependencyContext } from "../dependency-context-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

const EMPTY_CONTEXT: DetailDependencyContext = { exposure: undefined, directKnown: true, upstreams: [] };

describe("DependencyContextDetails", () => {
  it("shows scored roles independently of serial and basket graph links", () => {
    const card = makeV9Card();
    card.dependencies.roles = [{
      edgeKey: "exit-usdc", exposureKey: "exit", riskEventKey: "exit-event",
      upstreamAssetId: "usdc-circle", role: "exit-dependency", weight: 0.25,
      targetPillar: "exit",
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

  describe("direct USD exposure availability", () => {
    const HUB = "usdc-circle";
    const edge = (from: string, to: string, kind: "serial" | "basket", weight: number | null): ReportCardsV9DependencyEdge => ({
      from, to, kind, weight, upstreamScore: 80,
      materiality: kind === "serial" ? "serial" : weight === null ? "basket-bounded-unknown" : "basket-weighted",
    });
    const cards = ["a", "b", "other", HUB].map((id) => ({ id, sharedBookId: null }));
    function renderContext(edges: ReportCardsV9DependencyEdge[], mcap: Record<string, number | null>) {
      const context = buildDetailDependencyContext(HUB, cards, edges, new Map(Object.entries(mcap)), 100);
      const { container } = render(<DependencyContextDetails card={makeV9Card({ id: HUB })} context={context} marketCapAsOf={100} />);
      return { context, text: container.textContent ?? "" };
    }

    it.each<{ label: string; edges: ReportCardsV9DependencyEdge[]; mcap: Record<string, number | null> }>([
      { label: "all shares unknown with known supplies", edges: [edge(HUB, "a", "basket", null), edge(HUB, "b", "basket", null)], mcap: { a: 100, b: 200 } },
      { label: "known share with missing supply plus unknown share with known supply", edges: [edge(HUB, "a", "basket", 0.5), edge(HUB, "b", "basket", null)], mcap: { a: null, b: 200 } },
      { label: "all supplies missing", edges: [edge(HUB, "a", "basket", 0.5), edge(HUB, "b", "serial", null)], mcap: {} },
      { label: "unrelated known edge and missing-endpoint edge", edges: [edge(HUB, "a", "basket", null), edge("other", "b", "basket", 0.5), edge(HUB, "missing", "basket", 0.5)], mcap: { a: 100, b: 200, missing: 300 } },
    ])("withholds a $0 total for $label", ({ edges, mcap }) => {
      const { context, text } = renderContext(edges, mcap);
      expect(context.directKnown).toBe(false);
      expect(text).toContain("Direct USD exposure unavailable.");
      expect(text).not.toContain("known direct exposure");
      expect(text).not.toContain("$0");
    });

    it("keeps an observed zero share and zero supply as $0", () => {
      const { context, text } = renderContext([edge(HUB, "a", "basket", 0), edge(HUB, "b", "basket", 0.5)], { a: 100, b: 0 });
      expect(context.directKnown).toBe(true);
      expect(text).toContain("$0.00 known direct exposure.");
    });

    it("shows a positive known subtotal beside unknown contributors with its incomplete note", () => {
      const { text } = renderContext([edge(HUB, "a", "basket", 0.5), edge(HUB, "b", "basket", null)], { a: 1_000, b: 200 });
      expect(text).toMatch(/\$500(\.00)? known direct exposure\./);
      expect(text).toContain("2 direct dependents.");
      expect(text).toContain("1 published link has an unknown share; USD exposure is incomplete.");
    });

    it("counts a serial claim with a null weight as a full known share", () => {
      const { context, text } = renderContext([edge(HUB, "a", "serial", null)], { a: 300 });
      expect(context.directKnown).toBe(true);
      expect(text).toMatch(/\$300(\.00)? known direct exposure\./);
    });

    it("treats an empty context as known without a dependents section", () => {
      const { context, text } = renderContext([], {});
      expect(context.directKnown).toBe(true);
      expect(text).not.toContain("What depends on me");
    });
  });
});
