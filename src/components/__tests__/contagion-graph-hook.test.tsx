// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type * as ContagionLayout from "@/lib/contagion-layout";
import { useContagionGraphModel } from "@/components/contagion-graph/use-contagion-graph-model";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/contagion-layout", async () => {
  const actual = await vi.importActual<typeof ContagionLayout>("@/lib/contagion-layout");
  return { ...actual, runSimulation: () => new Map() };
});


describe("full-graph supernode semantics", () => {
  it("keeps tiers and exposure stable through Limit 200 to 50 to 200 and matches a cold load", () => {
    const cards: ContagionGraphCard[] = Array.from({ length: 220 }, (_, index) => ({
      id: `coin-${index}`, symbol: `C${index}`, grade: "B",
    }));
    const mcapMap = new Map(cards.map((card, index) => [card.id, (220 - index) * 1_000_000]));
    const dependencyEdges: ReportCardsV9DependencyEdge[] = cards.slice(5).map((card, index) => ({
      from: cards[index % 5].id, to: card.id, kind: "basket", materiality: "basket-weighted",
      weight: (index % 5 + 1) / 10, upstreamScore: 50,
    }));
    const options = { cards, mcapMap, dependencyEdges, trackActions: false };
    const warm = renderHook(() => useContagionGraphModel(options));
    const originalTiers = [...warm.result.current.supernodeState.tierById];
    const originalExposure = warm.result.current.directExposureById.get("coin-0")!.direct.knownUsd;
    expect(warm.result.current.nodes).toHaveLength(200);
    act(() => warm.result.current.setNodeLimit(50));
    expect(warm.result.current.nodes).toHaveLength(50);
    expect([...warm.result.current.supernodeState.tierById]).toEqual(originalTiers);
    expect(warm.result.current.directExposureById.get("coin-0")!.direct.knownUsd).toBe(originalExposure);
    act(() => warm.result.current.setNodeLimit(200));
    const cold = renderHook(() => useContagionGraphModel(options));
    expect([...warm.result.current.supernodeState.tierById]).toEqual(originalTiers);
    expect([...warm.result.current.supernodeState.tierById]).toEqual([...cold.result.current.supernodeState.tierById]);
    expect([...warm.result.current.supernodeState.scoreById]).toEqual([...cold.result.current.supernodeState.scoreById]);
    warm.unmount();
    cold.unmount();
  });
});
