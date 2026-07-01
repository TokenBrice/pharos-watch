// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContagionGraphControls } from "@/components/contagion-graph/contagion-graph-controls";
import { ALL_NODE_LIMIT } from "@/lib/contagion-layout";

afterEach(() => {
  cleanup();
});

function renderControls(onNodeLimitChange = vi.fn()) {
  render(
    <ContagionGraphControls
      focusMode="all"
      edgeTypeFilter="all"
      nodeLimit={50}
      nodeSelectOptions={[{ id: "usdc-circle", symbol: "USDC", mcap: 1_000_000_000 }]}
      selectedNeighborhoodId={null}
      onFocusModeChange={vi.fn()}
      onEdgeTypeFilterChange={vi.fn()}
      onNodeLimitChange={onNodeLimitChange}
      onTraceNodeChange={vi.fn()}
    />,
  );
  return { onNodeLimitChange };
}

describe("ContagionGraphControls", () => {
  it("emits the all node-limit option without numeric coercion", () => {
    const { onNodeLimitChange } = renderControls();

    const limitControls = screen.getByRole("group", { name: "Maximum nodes shown" });
    fireEvent.click(within(limitControls).getByText("All"));

    expect(onNodeLimitChange).toHaveBeenCalledWith(ALL_NODE_LIMIT);
  });
});
