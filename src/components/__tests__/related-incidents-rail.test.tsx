// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { RelatedIncidentsRail } from "@/components/related-incidents-rail";

vi.mock("@/lib/depeg-event-snapshot", () => ({
  readDepegEventPageEntries: () => [{
    slug: "eurc-peer-peak", stablecoinId: "eurc-circle", symbol: "EURC", pegType: "peggedEUR",
    direction: "below", peakDeviationBps: -963, peakBasis: "peer-relative", startedAt: 1_795_129_200,
  }],
}));
vi.mock("../../../scripts/lib/generated-artifacts", () => ({ syncGeneratedArtifacts: vi.fn() }));
vi.mock("@/generated/depeg-event-related-data.json", async (importOriginal) => {
  const { default: entries } = await importOriginal<typeof import("@/generated/depeg-event-related-data.json")>();
  const { syncGeneratedArtifacts } = await import("../../../scripts/lib/generated-artifacts");
  await import("../../../scripts/maintenance/generate-depeg-event-search-data");
  const artifact = vi.mocked(syncGeneratedArtifacts).mock.calls[0][0].artifacts
    .find(({ path }) => path.endsWith("depeg-event-related-data.json"))!;
  return { default: [...entries, ...JSON.parse(artifact.contents)] };
});

describe("RelatedIncidentsRail", () => {
  it("labels the same-peg group from the peg vocabulary, never the wire enum", () => {
    render(<RelatedIncidentsRail excludeEventId="lusd-2026-10-29" pegCurrency="USD" />);

    expect(screen.getByText("Other recent US Dollar depegs")).toBeTruthy();
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.queryByText(/peggedUSD/)).toBeNull();
  });

  it("uses the shared mechanism-archetype label in the heading", () => {
    const view = render(<RelatedIncidentsRail riskArchetype="cdp" />);

    expect(screen.getByText("Other Crypto CDP incidents")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/cdp incidents|fiat-cash/);
  });

  it("keeps the reviewed BRZ link and omits its unverified peak magnitude", () => {
    render(<RelatedIncidentsRail excludeEventId="brz-2023-02-07" pegCurrency="BRL" riskArchetype="fiat-cash" startedAt={1675728000} />);

    const link = screen.getByRole("link", { name: /^2023-02-11\s*BRZ\s*Peak unverified$/ });
    expect(link.getAttribute("href")).toBe("/depeg/brz-2023-02-11");
  });

  it("qualifies the disputed EURm peak in the generated related links", () => {
    render(<RelatedIncidentsRail excludeEventId="eurs-2026-11-10" pegCurrency="EUR" riskArchetype="fiat-cash" startedAt={1794317479} />);

    const link = screen.getByRole("link", { name: /EURm.*159\.8% above peg \(Disputed\)/ });
    expect(link.getAttribute("href")).toBe("/depeg/eurm-2026-08-12");
  });

  it("names the comparison used by a peer-relative peak", () => {
    render(<RelatedIncidentsRail pegCurrency="EUR" />);

    expect(screen.getByRole("link", { name: /EURC.*9\.63% below the peer median/ }).getAttribute("href"))
      .toBe("/depeg/eurc-peer-peak");
  });
});
