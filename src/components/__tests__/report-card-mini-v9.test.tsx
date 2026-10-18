// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportCardMiniV9 } from "../report-card-mini-v9";
import { projectV9TableCard } from "@shared/lib/report-cards-v9-projections";
import { makeReportCardsV9Response, makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { makeReportCardsV9PartialCard } from "@shared/test-utils/report-cards-v9";
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

  it("does not gate or invent an unavailable pillar radar", () => {
    installMatchMediaMock();
    const partial = projectV9TableCard(makeReportCardsV9PartialCard("exit", "B", { id: "usdt-tether" }));
    render(<ReportCardMiniV9 card={partial} identity={identity} />);
    expect(screen.getByText("Pillar radar unavailable")).toBeTruthy();
    expect(screen.getByText("Partial evidence · pipeline gap")).toBeTruthy();
    expect(screen.queryByTestId("mini-radar")).toBeNull();
  });
});
