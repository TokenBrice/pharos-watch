// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CONTROL_COMPONENT_ROLE_LABELS } from "@shared/lib/classification";
import type { ControlStripComponent, ControlStripView, ExitStripView } from "@/lib/pillar-evidence-strips";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import { PillarEvidenceStrip } from "../pillar-evidence-strip";

function control(key: string, score: number | null, role: ControlStripComponent["role"]): ControlStripComponent {
  return {
    key, label: key, kind: "mint", score, posture: "p", postureLabel: "Posture", role, tone: "neutral",
  };
}

const CONTROL_VIEW: ControlStripView = {
  pillar: "control",
  score: 45,
  grade: "D",
  excluded: false,
  minimum: 45,
  adjustments: [],
  evaluatedScore: 45,
  adjusted: false,
  rows: [
    { type: "component", component: control("oracle", 45, "limiting"), scope: null },
    { type: "component", component: control("mint", 68, "eligible"), scope: null },
    { type: "group", group: { key: "bridge:diagnostic", kind: "bridge", role: "diagnostic", count: 31, noun: "bridge controls", postureLabel: null, minScore: 45, maxScore: 45, tone: "warn" } },
  ],
};

describe("PillarEvidenceStrip", () => {
  it("renders only the kicker heading without a view", () => {
    const { container } = render(
      <PillarEvidenceStrip pillar="control" headingId="control-evidence-heading" title="Control evidence" view={null} />,
    );
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.id).toBe("control-evidence-heading");
    expect(container.childElementCount).toBe(1);
    expect(container.firstElementChild).toBe(heading);
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("keeps the provenance anchors under the bare kicker when the card is missing", () => {
    const review: MechanismReviewView = {
      archetype: "fiat-cash",
      reviewedAt: "2026-07-15",
      notes: "Segregated reserve accounts.",
      sources: [],
    };
    const { container: backing } = render(
      <PillarEvidenceStrip pillar="backing" headingId="b" title="Backing evidence" view={null} mechanismReview={review} />,
    );
    expect(backing.querySelector("#mechanism-review")).toBeTruthy();
    const { container: controlBoard } = render(
      <PillarEvidenceStrip
        pillar="control"
        headingId="c"
        title="Control evidence"
        view={null}
        controlPosture={{
          key: "single-entity", label: "Issuer controlled", shortLabel: "Issuer", badgeClassName: "",
          summary: "", facts: [], details: [], scope: "LOCAL",
        }}
      />,
    );
    expect(controlBoard.querySelector("#control-posture")?.textContent).toContain("Issuer controlled");
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("attaches the limiting label and glyph only to limiting components, with one legend tag per role", () => {
    const { container } = render(
      <PillarEvidenceStrip pillar="control" headingId="h" title="Control evidence" view={CONTROL_VIEW} />,
    );
    const limitingLabel = CONTROL_COMPONENT_ROLE_LABELS.limiting;
    const bars = screen.getAllByRole("img");
    const limitingBars = bars.filter((bar) => bar.getAttribute("aria-label")?.includes(limitingLabel));
    expect(limitingBars).toHaveLength(1);
    expect(limitingBars[0]!.getAttribute("aria-label")).toMatch(/^oracle\b/);
    // Row glyphs: one limiting (oracle), one diagnostic (the bridge group); the eligible mint has none.
    expect(container.querySelectorAll('li [data-control-glyph="limiting"]')).toHaveLength(1);
    expect(container.querySelectorAll('li [data-control-glyph="diagnostic"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-control-role="limiting"]')).toHaveLength(1);
    expect(container.querySelector('[data-control-role="diagnostic"]')?.textContent).toBe(CONTROL_COMPONENT_ROLE_LABELS.diagnostic);
  });

  it("puts the provenance anchor on the strip container so a jump lands above the bars", () => {
    render(
      <PillarEvidenceStrip
        pillar="control"
        headingId="h"
        title="Control evidence"
        view={CONTROL_VIEW}
        controlPosture={{
          key: "single-entity", label: "Issuer controlled", shortLabel: "Issuer", badgeClassName: "bg-purple-100",
          summary: "", facts: [], details: [], scope: "LOCAL",
        }}
      />,
    );
    const anchor = document.getElementById("control-posture");
    expect(anchor?.contains(screen.getByRole("heading", { level: 2 }))).toBe(true);
    expect(anchor?.querySelectorAll('[role="img"]').length).toBeGreaterThan(0);
  });

  it("writes a no-route Exit as a formula ending in the pillar score", () => {
    render(
      <PillarEvidenceStrip
        pillar="exit"
        headingId="h"
        title="Exit evidence"
        view={{
          pillar: "exit", score: 35, grade: "F", excluded: false, route: null, backup: null, capacity: null,
          stressRequest: { requestedNotionalUsd: 25_000_000, maxCostBps: 200 },
          excludedRoutes: [{ key: "r", label: "Stablecoin redemption", score: null, reason: "Unsupported same notional route" }],
        }}
      />,
    );
    const formula = screen.getByText(/No route qualifies/);
    expect(formula.textContent).toMatch(/200 bps → Exit 35$/);
    expect(screen.getByText(/Stablecoin redemption/).textContent).toContain("not counted");
  });

  it("keeps the route label, capacity percent and tone in agreement", () => {
    const view = (completionRatio: number, qualified: boolean): ExitStripView => ({
      pillar: "exit", score: 62, grade: "C", excluded: false,
      route: { label: "Curve on Ethereum", family: "dex-amm", score: 62 },
      backup: null,
      capacity: {
        executableUsd: 25_000_000 * completionRatio, requestedNotionalUsd: 25_000_000, maxCostBps: 200,
        completionRatio, qualified, tone: qualified ? "neutral" : "warn",
      },
      stressRequest: { requestedNotionalUsd: 25_000_000, maxCostBps: 200 },
      excludedRoutes: [],
    });
    const capacityBar = () => screen.getAllByRole("img").find((bar) => bar.getAttribute("aria-label")?.startsWith("Executable capacity"))!;

    // A shortfall that would round to 100% must not read 100% beside "below the capacity threshold".
    for (const ratio of [0.0355, 0.994]) {
      const { unmount } = render(<PillarEvidenceStrip pillar="exit" headingId="h" title="Exit evidence" view={view(ratio, false)} />);
      expect(screen.getByText(/Selected route/).textContent).not.toMatch(/capacity-qualified/);
      expect(screen.queryByText("100%")).toBeNull();
      expect(capacityBar().getAttribute("aria-label")).toMatch(/below the capacity threshold/);
      // The route's number reconciles to the pillar score either way.
      expect(screen.getByText(/route value/).textContent).toMatch(/62 = Exit 62$/);
      unmount();
    }

    // USDe: a full fill a hair under 1 reads qualified at 100%.
    render(<PillarEvidenceStrip pillar="exit" headingId="h" title="Exit evidence" view={view(0.9995, true)} />);
    expect(screen.getByText(/Selected route/).textContent).toMatch(/capacity-qualified/);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(capacityBar().getAttribute("aria-label")).not.toMatch(/below/);
  });

  it("anchors the mechanism provenance and keeps its notes folded", () => {
    const review: MechanismReviewView = {
      archetype: "fiat-cash",
      reviewedAt: "2026-07-15",
      notes: "Segregated reserve accounts.",
      sources: [{ label: "Issuer terms", url: "https://example.com/terms" }],
    };
    const { container } = render(
      <PillarEvidenceStrip
        pillar="backing"
        headingId="h"
        title="Backing evidence"
        mechanismReview={review}
        view={{ pillar: "backing", score: 76, grade: "B+", excluded: false, groups: [], mechanism: [] }}
      />,
    );
    const anchor = container.querySelector("#mechanism-review");
    expect(anchor?.textContent).toContain(review.reviewedAt);
    expect(screen.getByText(/Segregated reserve accounts/).closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("draws an excluded pillar without a score fill", () => {
    render(
      <PillarEvidenceStrip
        pillar="exit"
        headingId="h"
        title="Exit evidence"
        view={{
          pillar: "exit", score: null, grade: null, excluded: true, route: null, backup: null,
          capacity: null, stressRequest: null, excludedRoutes: [],
        }}
      />,
    );
    for (const bar of screen.getAllByRole("img")) expect(bar.childElementCount).toBe(0);
  });

  it("never calls an excluded Control pillar's empty eligible set a neutral score", () => {
    const diagnosticOnly = { type: "component" as const, component: control("bridge", 40, "diagnostic"), scope: null };
    const { unmount } = render(
      <PillarEvidenceStrip
        pillar="control"
        headingId="h"
        title="Control evidence"
        view={{ ...CONTROL_VIEW, score: null, grade: null, excluded: true, minimum: null, evaluatedScore: null, rows: [diagnosticOnly] }}
      />,
    );
    expect(screen.getByText(/Control not scored/)).toBeTruthy();
    expect(screen.queryByText(/neutral/i)).toBeNull();
    unmount();

    render(
      <PillarEvidenceStrip
        pillar="control"
        headingId="h"
        title="Control evidence"
        view={{ ...CONTROL_VIEW, score: 70, grade: "B-", minimum: null, evaluatedScore: 70, rows: [diagnosticOnly] }}
      />,
    );
    expect(screen.getByText(/neutral score/)).toBeTruthy();
    expect(screen.queryByText(/Control not scored/)).toBeNull();
  });
});
