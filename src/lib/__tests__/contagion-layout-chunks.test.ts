import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGraphData, buildSupernodeState, runSimulation, runSimulationInChunks } from "@/lib/contagion-layout";

const cards = [
  { id: "a", symbol: "A", grade: "A" as const },
  { id: "b", symbol: "B", grade: "B" as const },
];
const graph = buildGraphData(cards, new Map([["a", 1e9], ["b", 1e8]]), [
  { from: "b", to: "a", kind: "serial", materiality: "serial", weight: null, upstreamScore: null },
], "all");
const state = buildSupernodeState(graph.nodes, graph.links);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("chunked layout", () => {
  it("publishes exactly the synchronous solver coordinates after deferred work", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    runSimulationInChunks(graph.nodes, graph.links, state, complete);
    expect(complete).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledExactlyOnceWith(runSimulation(graph.nodes, graph.links, state));
  });

  it("does not publish a superseded layout even if an idle callback is already queued", () => {
    let pending: (() => void) | undefined;
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => { pending = callback; return 1; });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const complete = vi.fn();
    const cancel = runSimulationInChunks(graph.nodes, graph.links, state, complete);
    cancel();
    pending?.();
    expect(complete).not.toHaveBeenCalled();
  });
});
