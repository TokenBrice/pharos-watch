// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DependencyMapMobileSummary } from "@/components/dependency-map-mobile-summary";
import { buildDependencyHubsModel } from "@/lib/dependency-hubs-model";
import { trackEvent } from "@/lib/analytics";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
const cards = [{ id: "parent", name: "Parent", symbol: "P" }, { id: "child", name: "Child", symbol: "C" }];
const edges: ReportCardsV9DependencyEdge[] = [{ from: "parent", to: "child", kind: "serial", materiality: "serial", weight: null, upstreamScore: 80 }];

describe("DependencyMapMobileSummary", () => {
  it("keeps a null-supply dependent visible without claiming zero exposure", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["child", null]]) });
    render(<DependencyMapMobileSummary model={model} />);
    expect(screen.getByText("Direct exposure n/a")).toBeTruthy();
    expect(screen.getByText(/1 supplies unavailable/)).toBeTruthy();
    expect(screen.getByText(/mcap n\/a/)).toBeTruthy();
  });
  it("offers a coin navigation action with its own analytics event", () => {
    const model = buildDependencyHubsModel({ cards, edges, mcapMap: new Map([["child", 1000]]) });
    render(<DependencyMapMobileSummary model={model} />);
    const link = screen.getByRole("link", { name: "Open coin Parent" });
    expect(link.getAttribute("href")).toBe("/stablecoin/parent");
    fireEvent.click(link);
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "hub_open_coin", value: "parent" });
    expect(screen.getByText("100% from C")).toBeTruthy();
  });
});
