// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import type * as ContagionLayout from "@/lib/contagion-layout";
import { ContagionGraph } from "@/components/contagion-graph-root";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/contagion-layout", async () => {
  const actual = await vi.importActual<typeof ContagionLayout>("@/lib/contagion-layout");
  return {
    ...actual,
    runSimulationInChunks: vi.fn((_nodes, _links, _state, complete) => {
      complete(new Map([
        ["usdc-circle", { x: 300, y: 300 }],
        ["usde-ethena", { x: 500, y: 300 }],
      ]));
      return () => {};
    }),
  };
});

const cards = [
  { id: "usdc-circle", symbol: "USDC", grade: "A" as const },
  { id: "usde-ethena", symbol: "USDe", grade: "B" as const },
];
const edges: ReportCardsV9DependencyEdge[] = [{
  from: "usdc-circle", to: "usde-ethena", kind: "basket", materiality: "basket-weighted", weight: 0.8, upstreamScore: 84,
}];
const mcapMap = new Map([["usdc-circle", 60_000_000_000], ["usde-ethena", 5_000_000_000]]);

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

describe("Detail dependency graph help", () => {
  it.each(["pointer", "keyboard"] as const)("keeps help accessible before interaction and remembers the first %s interaction", (interaction) => {
    render(<ContagionGraph cards={cards} dependencyEdges={edges} mcapMap={mcapMap} focusCoinId="usdc-circle" minimalChrome />);
    const graph = screen.getByRole("group", { name: "Interactive dependency graph" });
    const help = document.getElementById(graph.getAttribute("aria-describedby")!);
    expect(help).not.toBeNull();
    expect(help?.classList.contains("sr-only")).toBe(true);
    expect(graph.getAttribute("tabindex")).toBe("0");
    expect(graph.hasAttribute("data-help-interacted")).toBe(false);
    if (interaction === "pointer") fireEvent.pointerDown(graph);
    else fireEvent.keyDown(screen.getByRole("combobox", { name: "Inspect dependency" }), { key: "ArrowDown" });
    expect(graph.getAttribute("data-help-interacted")).toBe("true");
    fireEvent.blur(graph);
    fireEvent.mouseLeave(graph);
    expect(graph.getAttribute("data-help-interacted")).toBe("true");
  });

  it("leaves map-page help visible without the detail interaction gate", () => {
    const { container } = render(<ContagionGraph cards={cards} dependencyEdges={edges} mcapMap={mcapMap} />);
    expect(screen.queryByRole("group", { name: "Interactive dependency graph" })).toBeNull();
    expect(container.querySelectorAll("[data-help-interacted]")).toHaveLength(0);
    for (const help of screen.getAllByText(/Arrows point to the asset/)) {
      expect(help.classList.contains("sr-only")).toBe(false);
    }
  });
});
