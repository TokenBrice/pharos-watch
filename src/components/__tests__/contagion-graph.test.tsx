// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { installSvgCoordinateShim } from "./contagion-graph-test-support";

vi.mock("@/lib/contagion-layout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/contagion-layout")>("@/lib/contagion-layout");

  return {
    ...actual,
    runSimulation: () =>
      new Map([
        ["usde-ethena", { x: 220, y: 300 }],
        ["usdtb-ethena", { x: 320, y: 300 }],
        ["usdc-circle", { x: 440, y: 300 }],
        ["dai-makerdao", { x: 560, y: 300 }],
      ]),
  };
});

const { ContagionGraph } = await import("@/components/contagion-graph-root");

const CARDS: ContagionGraphCard[] = [
  { id: "usde-ethena", symbol: "USDe", grade: "A" },
  { id: "usdtb-ethena", symbol: "USDTB", grade: "B" },
  { id: "usdc-circle", symbol: "USDC", grade: "A" },
  { id: "dai-makerdao", symbol: "DAI", grade: "A" },
];

const MCAP_MAP = new Map([
  ["usde-ethena", 5_000_000_000],
  ["usdtb-ethena", 2_000_000_000],
  ["usdc-circle", 60_000_000_000],
  ["dai-makerdao", 4_000_000_000],
]);

const DEPENDENCY_EDGES: ReportCardsV9DependencyEdge[] = [
  {
    from: "usdtb-ethena",
    to: "usde-ethena",
    kind: "serial",
    materiality: "serial",
    weight: null,
    upstreamScore: null,
  },
  {
    from: "usde-ethena",
    to: "usdc-circle",
    kind: "basket",
    materiality: "basket-weighted",
    weight: 0.8,
    upstreamScore: null,
  },
  {
    from: "dai-makerdao",
    to: "usdc-circle",
    kind: "basket",
    materiality: "basket-weighted",
    weight: 0.4,
    upstreamScore: null,
  },
];

beforeAll(installSvgCoordinateShim);

afterEach(() => {
  cleanup();
});

describe("ContagionGraph", () => {
  function getTraceCoinPicker(): HTMLSelectElement {
    const picker = screen.getByLabelText("Trace coin");
    if (!(picker instanceof HTMLSelectElement)) {
      throw new TypeError("Expected the trace coin control to be a select element");
    }
    return picker;
  }

  it("renders no graph for an empty dataset", () => {
    const { container } = render(<ContagionGraph cards={[]} dependencyEdges={[]} mcapMap={new Map()} />);

    expect(container.firstChild).toBeNull();
  });

  it("renders the expected visible node and edge counts", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    expect(screen.getAllByRole("button", { name: /market cap/i })).toHaveLength(4);
    expect(container.querySelectorAll('svg line[stroke="transparent"]')).toHaveLength(3);
  });

  it("shows focused node styling and announces the focused node", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    fireEvent.focus(screen.getByRole("button", { name: /USDC/i }));

    expect(container.querySelector('circle[stroke="var(--color-ring)"][stroke-dasharray="4 2"]')).not.toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("USDC, Grade A");
  });

  it("supports keyboard neighborhood focus and directional node navigation", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("button", { name: "Selected neighborhood" }));

    const nodePicker = getTraceCoinPicker();
    const usdcNode = screen.getByRole("button", { name: /USDC/i });
    usdcNode.focus();

    fireEvent.keyDown(usdcNode, { key: "Enter" });
    expect(nodePicker.value).toBe("usdc-circle");

    fireEvent.keyDown(usdcNode, { key: "ArrowLeft" });
    expect((document.activeElement as HTMLElement | null)?.getAttribute("data-node-id")).toBe("usde-ethena");
  });

  it("lets clicks retarget the selected neighborhood", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("button", { name: "Selected neighborhood" }));

    const nodePicker = getTraceCoinPicker();
    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));

    expect(nodePicker.value).toBe("usde-ethena");
  });

  it("does not retarget the selected neighborhood on the click emitted after a drag", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Selected neighborhood" }));

    const nodePicker = getTraceCoinPicker();
    const initialValue = nodePicker.value;
    const dragTarget = screen
      .getAllByRole("button", { name: /market cap/i })
      .find((node) => node.getAttribute("data-node-id") !== initialValue);
    expect(dragTarget).toBeTruthy();

    fireEvent.pointerDown(dragTarget!, { isPrimary: true, clientX: 220, clientY: 300, pointerId: 1 });
    const svg = container.querySelector('[role="figure"] svg');
    fireEvent.pointerMove(svg!, { clientX: 270, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(svg!, { pointerId: 1 });
    fireEvent.click(dragTarget!);

    expect(nodePicker.value).toBe(initialValue);
  });

  it("shows an edge tooltip labelled by relationship on edge hover", async () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    const edgeHitArea = container.querySelectorAll('svg line[stroke="transparent"]')[0];
    expect(edgeHitArea).not.toBeNull();

    fireEvent.mouseEnter(edgeHitArea!);

    await waitFor(() => {
      expect(container.textContent).toContain("USDTB");
      expect(container.textContent).toContain("Wrapper dependency");
    });
  });

  it("uses the trace picker to open a selected neighborhood", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    const nodePicker = getTraceCoinPicker();
    fireEvent.change(nodePicker, { target: { value: "usdc-circle" } });

    expect(nodePicker.value).toBe("usdc-circle");
    expect(screen.getByText(/Showing 3 of 4 dependency-linked stablecoins with 2 visible edges\./)).toBeTruthy();
  });

  it("filters visible edges by relationship", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("button", { name: "Wrapper" }));

    expect(screen.getByText(/Showing 4 of 4 dependency-linked stablecoins with 1 visible edges\./)).toBeTruthy();
  });

  it("reduces visible nodes in neighborhood mode for connected subsets", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    fireEvent.click(screen.getByRole("button", { name: "Selected neighborhood" }));
    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));

    expect(screen.getByText(/Showing 3 of 4 dependency-linked stablecoins with 2 visible edges\./)).toBeTruthy();
  });

  it("updates visible counts when focus mode changes", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);

    expect(screen.getByText(/Showing 4 of 4 dependency-linked stablecoins with 3 visible edges\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Selected neighborhood" }));

    const sr = screen.getByText(/Showing \d+ of \d+ dependency-linked stablecoins with \d+ visible edges\./);
    expect(sr.textContent).not.toMatch(/Showing 4 of 4 dependency-linked stablecoins with 3 visible edges\./);
  });

  it("clears the pinned selection when Escape is pressed", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));
    expect(container.querySelector('circle[stroke="var(--p-frost-blue)"]')).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(container.querySelector('circle[stroke="var(--p-frost-blue)"]')).toBeNull();
  });

  it("never mounts a modal dialog when a node is clicked", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /USDe/i }));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("double-clicking a pinned node unpins it", () => {
    const { container } = render(
      <ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />,
    );

    const usdeNode = screen.getByRole("button", { name: /USDe/i });
    // Simulate a drag to pin the node.
    fireEvent.pointerDown(usdeNode, { isPrimary: true, clientX: 220, clientY: 300, pointerId: 1 });
    const svg = container.querySelector('[role="figure"] svg');
    fireEvent.pointerMove(svg!, { clientX: 260, clientY: 320, pointerId: 1 });
    fireEvent.pointerUp(svg!, { pointerId: 1 });

    expect(container.querySelector('[data-pinned="true"]')).not.toBeNull();

    fireEvent.doubleClick(usdeNode);

    expect(container.querySelector('[data-pinned="true"]')).toBeNull();
  });
});
