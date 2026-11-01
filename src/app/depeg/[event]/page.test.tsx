// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { EVENTS, EVENTS_BY_SLUG } = vi.hoisted(() => {
  const base = {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below" as const,
    peakDeviationBps: 1_200,
    startedAt: 1_733_000_000,
    endedAt: 1_733_003_600,
    startPrice: 0.99,
    peakPrice: 0.98,
    recoveryPrice: 1,
    pegReference: 1,
    source: "live" as const,
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
  };
  const events = [
    { ...base, id: 1, slug: "disputed-event", provenance: { auditVerdict: "disputed" as const, confidenceTier: "high" } },
    { ...base, id: 2, slug: "confirmed-event", provenance: { auditVerdict: "confirmed" as const } },
  ];
  return { EVENTS: events, EVENTS_BY_SLUG: new Map(events.map((event) => [event.slug, event])) };
});

vi.mock("@/lib/depeg-event-page-data", () => ({
  DEPEG_EVENT_ENTRIES: EVENTS,
  eventBySlug: EVENTS_BY_SLUG,
  COLLIDING_DEPEG_EVENT_SLUGS: new Set<string>(),
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS: 0,
  NOINDEX_DEPEG_EVENT_SLUGS: new Set<string>(),
  formatIncidentNumber: () => null,
}));

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("@/components/related-incidents-rail", () => ({ RelatedIncidentsRail: () => null }));
vi.mock("@/components/preferred-source-prompt", () => ({ PreferredSourcePrompt: () => null }));

import DepegEventPage from "./page";

async function renderPage(slug: string) {
  const tree = await DepegEventPage({ params: Promise.resolve({ event: slug }) });
  return render(tree);
}

function provenanceLine(): HTMLElement {
  return screen.getByText(/Detected under/).closest("p")!;
}

describe("DepegEventPage provenance audit verdict", () => {
  it("prepends the shared Disputed pill and drops the raw audit token", async () => {
    await renderPage("disputed-event");

    const line = provenanceLine();
    expect(within(line).getByText("Disputed")).toBeTruthy();
    expect(line.textContent).not.toMatch(/audit:/i);
  });

  it("leaves other verdicts as the existing raw audit token", async () => {
    await renderPage("confirmed-event");

    const line = provenanceLine();
    expect(within(line).queryByText("Disputed")).toBeNull();
    expect(line.textContent).toContain("audit: confirmed");
  });
});
