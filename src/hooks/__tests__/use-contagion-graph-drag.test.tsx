// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useContagionGraphDrag } from "@/hooks/use-contagion-graph-drag";

beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "createSVGPoint", {
    configurable: true,
    value() {
      const point = {
        x: 0,
        y: 0,
        matrixTransform() {
          return { x: point.x, y: point.y };
        },
      };
      return point;
    },
  });

  Object.defineProperty(SVGSVGElement.prototype, "getScreenCTM", {
    configurable: true,
    value() {
      return {
        inverse() {
          return null;
        },
      };
    },
  });
});

function DragHarness({ simulationKey = "stable" }: { simulationKey?: string }) {
  const {
    positions,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    consumeDragMovedSincePointerDown,
  } = useContagionGraphDrag({
    nodeMap: new Map([["node-1", { r: 12 }]]),
    basePositions: new Map([["node-1", { x: 100, y: 100 }]]),
    simulationKey,
  });
  const pos = positions.get("node-1");

  return (
    <svg
      data-testid="drag-svg"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <g
        data-testid="drag-node"
        onPointerDown={(event) => handlePointerDown(event, "node-1")}
        onClick={() => {
          if (!consumeDragMovedSincePointerDown()) {
            document.body.dataset.clicked = "true";
          }
        }}
      >
        <circle cx={pos?.x} cy={pos?.y} r={12} />
      </g>
    </svg>
  );
}

describe("useContagionGraphDrag", () => {
  afterEach(() => {
    cleanup();
    delete document.body.dataset.clicked;
  });

  it("persists dragged positions within the active simulation key", async () => {
    const { container } = render(<DragHarness />);
    const node = screen.getByTestId("drag-node");
    const svg = screen.getByTestId("drag-svg");
    const circle = container.querySelector("circle");

    expect(circle?.getAttribute("cx")).toBe("100");
    expect(circle?.getAttribute("cy")).toBe("100");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    await waitFor(() => {
      expect(circle?.getAttribute("cx")).not.toBe("100");
      expect(circle?.getAttribute("cy")).not.toBe("100");
    });
  });

  it("resets pinned positions when the simulation key changes", async () => {
    const { container, rerender } = render(<DragHarness simulationKey="stable" />);
    const node = screen.getByTestId("drag-node");
    const svg = screen.getByTestId("drag-svg");
    const circle = container.querySelector("circle");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1 });

    await waitFor(() => {
      expect(circle?.getAttribute("cx")).not.toBe("100");
      expect(circle?.getAttribute("cy")).not.toBe("100");
    });

    rerender(<DragHarness simulationKey="expanded" />);

    await waitFor(() => {
      expect(circle?.getAttribute("cx")).toBe("100");
      expect(circle?.getAttribute("cy")).toBe("100");
    });

    rerender(<DragHarness simulationKey="stable" />);

    await waitFor(() => {
      expect(circle?.getAttribute("cx")).toBe("100");
      expect(circle?.getAttribute("cy")).toBe("100");
    });
  });

  it("lets consumers suppress the click that follows a drag", async () => {
    render(<DragHarness />);
    const node = screen.getByTestId("drag-node");
    const svg = screen.getByTestId("drag-svg");

    fireEvent.pointerDown(node, { pointerId: 1, clientX: 100, clientY: 100, isPrimary: true });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 140, clientY: 150 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    fireEvent.click(node);

    expect(document.body.dataset.clicked).toBeUndefined();

    fireEvent.click(node);

    expect(document.body.dataset.clicked).toBe("true");
  });
});
