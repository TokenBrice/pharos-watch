// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportCardMiniV9 } from "../report-card-mini-v9";
import { projectV9TableCard } from "@shared/lib/report-cards-v9-projections";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";
import { cleanupFrontendTest, installMatchMediaMock } from "@/test-utils/frontend";

vi.mock("@/components/radar-chart-v9", () => ({
  CompareRadarV9: () => <div data-testid="mini-radar" style={{ height: 140 }}>Radar</div>,
}));

const identity = makeReportCardsV9Response().safetyScoreIdentity;
const card = projectV9TableCard(makeV9Card({
  id: "usdt-tether",
  pillars: makeV9Pillars({ backing: 80, exit: 70, control: 60 }),
}));

afterEach(cleanupFrontendTest);

describe("ReportCardMiniV9 viewport radar", () => {
  it("keeps identity, grade and exact pillar text in server markup without mounting a radar", () => {
    const html = renderToStaticMarkup(<ReportCardMiniV9 card={card} identity={identity} />);
    expect(html).toContain("Tether");
    expect(html).toContain("Safety grade");
    expect(html).toContain("Backing 80/100; Exit 70/100; Economic Control 60/100.");
    expect(html).toContain("min-height:140px");
    expect(html).not.toContain("mini-radar");
  });

  it("mounts only the near-viewport radar while retaining its exact-height reserve", () => {
    installMatchMediaMock();
    const observers: Array<{ callback: IntersectionObserverCallback; target?: Element; margin?: string }> = [];
    vi.stubGlobal("IntersectionObserver", class {
      entry: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.entry = { callback, margin: options?.rootMargin };
        observers.push(this.entry);
      }
      observe(target: Element) { this.entry.target = target; }
      disconnect() {}
      unobserve() {}
    });
    const { container } = render(<ReportCardMiniV9 card={card} identity={identity} />);
    expect(screen.getByText("Tether")).toBeTruthy();
    expect(screen.queryByTestId("mini-radar")).toBeNull();
    const near = observers.find((observer) => observer.margin === "200px")!;
    expect(near).toBeTruthy();
    expect((near.target as HTMLElement).style.minHeight).toBe("140px");
    act(() => near.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(screen.getByTestId("mini-radar")).toBeTruthy();
    expect((near.target as HTMLElement).style.minHeight).toBe("140px");
    expect(container.textContent).toContain("Backing 80/100; Exit 70/100; Economic Control 60/100.");
  });

  it("draws a rated card with a missing pillar and names the curation gap without pipeline wording", () => {
    installMatchMediaMock();
    const partial = projectV9TableCard(makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether" }));
    const html = renderToStaticMarkup(<ReportCardMiniV9 card={partial} identity={identity} />);
    expect(html).toContain("Exit excluded · awaiting curation");
    expect(html).not.toContain("pipeline gap");
    expect(html).toContain("Backing 80/100; Exit unknown, not plotted; Economic Control 80/100.");
    expect(html).not.toContain("Pillar radar unavailable");
  });

  it("renders phase-1 missing assumptions as unknown without a numeric stand-in", () => {
    const partial = projectV9TableCard(makeV9Card({ id: "usdt-tether" }));
    partial.pillars.exit = { score: null, aggregationDisposition: "unavailable" };
    partial.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: ["exit"], causes: [] };
    const html = renderToStaticMarkup(<ReportCardMiniV9 card={partial} identity={identity} />);
    expect(html).toContain("Exit unknown");
    expect(html).toContain("Exit has no usable evidence; the score uses an assumed value in its place.");
    expect(html).not.toMatch(/assumed \d|pipeline gap|unresolved|undisclosed by issuer|Pillar radar unavailable/);
  });

  it.each([
    ["exit", "U", 50, "Exit unresolved", "Exit is unresolved; the score assumes 50/100 until it is."],
    ["backing", "C", 35, "Backing undisclosed by issuer", "The issuer does not disclose Backing evidence; the score assumes 35/100 in its place."],
  ] as const)("labels a priced-unknown %s pillar by its %s cause", (pillar, cause, score, label, summary) => {
    const priced = projectV9TableCard(makeV9Card({ id: "usdt-tether", pillars: makeV9Pillars({ backing: 60, exit: 60, control: 60 }) }));
    priced.pillars[pillar] = { score: null, aggregationDisposition: "unavailable", pricedUnknown: { cause, score } };
    priced.partialEvidence = { reasonCode: "partial-evidence-pipeline-gap", excludedPillars: [pillar], causes: [] };
    const html = renderToStaticMarkup(<ReportCardMiniV9 card={priced} identity={identity} />);
    expect(html).toContain(label);
    expect(html).toContain(summary);
    expect(html).not.toContain("pipeline gap");
    expect(html).toContain("min-height:140px");
  });

  it("keeps data-pipeline-unavailable wording only for cause A and hides the radar below two pillars", () => {
    const gap = projectV9TableCard(makeReportCardsV9PipelineGapCard("control", "A", { id: "usdt-tether" }));
    const html = renderToStaticMarkup(<ReportCardMiniV9 card={gap} identity={identity} />);
    expect(html).toContain("Backing and Exit excluded · data pipeline unavailable");
    expect(html).toContain("Pillar radar unavailable");
  });
});
