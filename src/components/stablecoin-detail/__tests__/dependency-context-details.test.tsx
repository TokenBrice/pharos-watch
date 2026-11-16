// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { DependencySummary, OutsideGraphList, ScoredRoleList } from "../dependency-context-details";
import { buildDetailDependencyContext, coverageReasonLabel, formatDependencyShare } from "../dependency-context-model";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

describe("dependency context details", () => {
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
    render(<ScoredRoleList roles={card.dependencies.roles} gradeOf={() => undefined} />);
    const roles = screen.getByRole("region", { name: "Scored dependency roles" });
    const link = within(roles).getByRole("link", { name: "USDC, Exit dependency, 25% weight, role score 84/100" });
    expect(link.getAttribute("href")).toBe("/stablecoin/usdc-circle");
    expect(roles.textContent).toContain("84/100");
  });

  it("discloses coverage shares and reasons without linking unverified identities or adding exposure", () => {
    const card = makeV9Card({ dependencyCoverage: [
      { upstreamLabel: "USDC", upstreamAssetId: "usdc-circle", share: 0.12,
        reason: "stale-evidence", sourceAsOf: "2026-08-31", identityVerified: true },
      { upstreamLabel: "Unverified bridge claim", upstreamAssetId: null, share: null,
        reason: "identity-unverified", sourceAsOf: null, identityVerified: false },
    ] });
    render(<OutsideGraphList coverage={card.dependencyCoverage!} />);
    const coverage = screen.getByRole("region", { name: "Known but not scored" });
    expect(within(coverage).getByRole("link", { name: "USDC" })).toBeTruthy();
    expect(within(coverage).queryByRole("link", { name: "Unverified bridge claim" })).toBeNull();
    expect(coverage.textContent).toContain("12%");
    expect(coverage.textContent).toContain("Evidence is out of date");
    expect(coverage.textContent).toContain("Exact claim identity unverified");
    expect(coverage.textContent).not.toContain("stale-evidence");
    expect(coverage.textContent).toContain("2026-08-31");
    expect(coverage.textContent).toContain("Share unknown");
    expect(coverage.textContent).toContain("Identity unverified");
  });

  it("states a shared reason and provenance once for its whole group, in plain words", () => {
    const row = (upstreamLabel: string, share: number, reason = "missing-reserve-composition") => ({
      upstreamLabel, upstreamAssetId: null, share, reason, sourceAsOf: "2026-09-30", identityVerified: true,
    });
    render(<OutsideGraphList coverage={[row("PAXG", 0.01313), row("ysyBOLD", 0.001), row("XAUt", 0.01597)]} />);
    const coverage = screen.getByRole("region", { name: "Known but not scored" });
    expect(within(coverage).getAllByText("Reserve composition not published")).toHaveLength(1);
    expect(within(coverage).getAllByText("Identity verified · source as of 2026-09-30")).toHaveLength(1);
    expect(coverage.textContent).not.toContain("missing-reserve-composition");
    expect(within(coverage).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["XAUt1.6%", "PAXG1.3%", "ysyBOLD0.1%"]);
  });

  it.each([
    ["missing-reserve-composition", "Reserve composition not published"],
    ["outside-active-set:usdc-circle", "Not an actively scored stablecoin"],
    ["coinId-without-depType", "Relationship type not reviewed yet"],
    ["some-future-code", "Some future code"],
  ])("humanizes the coverage reason %s", (reason, label) => {
    expect(coverageReasonLabel(reason)).toBe(label);
  });

  it.each([[0.5, "50%"], [0.01313, "1.3%"], [0.0004, "<0.1%"], [0.99999, ">99.9%"], [1, "100%"], [0, "0%"]])(
    "formats share %s as %s", (share, label) => {
      expect(formatDependencyShare(share)).toBe(label);
    },
  );

  describe("direct USD exposure availability", () => {
    const HUB = "usdc-circle";
    const edge = (from: string, to: string, kind: "serial" | "basket", weight: number | null): ReportCardsV9DependencyEdge => ({
      from, to, kind, weight, upstreamScore: 80,
      materiality: kind === "serial" ? "serial" : weight === null ? "basket-bounded-unknown" : "basket-weighted",
    });
    const cards = ["a", "b", "other", HUB].map((id) => ({ id, sharedBookId: null }));
    function renderContext(edges: ReportCardsV9DependencyEdge[], mcap: Record<string, number | null>) {
      const context = buildDetailDependencyContext(HUB, cards, edges, new Map(Object.entries(mcap)), 100);
      const { container } = render(<DependencySummary symbol="USDC" context={context} usage={[]} marketCapAsOf={100} />);
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
      expect(text).toContain("Known direct exposure–Direct USD exposure unavailable");
      expect(text).not.toContain("Market caps as of");
      expect(text).not.toContain("$0");
    });

    it("keeps an observed zero share and zero supply as $0", () => {
      const { context, text } = renderContext([edge(HUB, "a", "basket", 0), edge(HUB, "b", "basket", 0.5)], { a: 100, b: 0 });
      expect(context.directKnown).toBe(true);
      expect(text).toContain("Known direct exposure$0.00Market caps as of 1970-01-01");
    });

    it("shows a positive known subtotal beside unknown contributors with its incomplete note", () => {
      const { text } = renderContext([edge(HUB, "a", "basket", 0.5), edge(HUB, "b", "basket", null)], { a: 1_000, b: 200 });
      expect(text).toMatch(/Known direct exposure\$500(\.00)?/);
      expect(text).toContain("Depend on USDC2");
      expect(text).toContain("1 link has an unknown share, so the exposure total is incomplete.");
    });

    it("counts a serial claim with a null weight as a full known share", () => {
      const { context, text } = renderContext([edge(HUB, "a", "serial", null)], { a: 300 });
      expect(context.directKnown).toBe(true);
      expect(text).toMatch(/Known direct exposure\$300(\.00)?/);
    });

    it("treats an empty context as known and collapses both directions to one sentence", () => {
      const { context, text } = renderContext([], {});
      expect(context.directKnown).toBe(true);
      expect(text).toBe("No tracked stablecoin depends on USDC, and its backing has no scored links to other stablecoins.");
    });
  });
});
