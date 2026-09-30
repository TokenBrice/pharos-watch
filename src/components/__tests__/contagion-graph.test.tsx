// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContagionGraphCard } from "@/lib/contagion-layout";
import type { ReportCardsV9DependencyEdge } from "@shared/types/report-cards-v9";
import { installSvgCoordinateShim } from "./contagion-graph-test-support";
import { buildGraphData, buildSupernodeState } from "@/lib/contagion-layout";
import { trackEvent } from "@/lib/analytics";

vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

let desktop = false;
let mediaListener: (() => void) | undefined;
beforeEach(() => {
  window.history.replaceState(null, "", "/dependency-map/");
  vi.mocked(trackEvent).mockClear();
  desktop = false;
  mediaListener = undefined;
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return desktop; },
    addEventListener: (_: string, listener: () => void) => { mediaListener = listener; },
    removeEventListener: () => { mediaListener = undefined; },
  }));
});

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
        ["dusd-alto", { x: 160, y: 240 }],
        ["dusd-dialectic", { x: 340, y: 240 }],
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


describe("ContagionGraph", () => {
  function getTraceCoinPicker(): HTMLSelectElement {
    const picker = screen.getByLabelText("Trace coin");
    if (!(picker instanceof HTMLSelectElement)) {
      throw new TypeError("Expected the trace coin control to be a select element");
    }
    return picker;
  }
  it("does not promise fullscreen in a detail snapshot", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} minimalChrome />);
    expect(screen.getByText("Tap a node to inspect dependencies.")).toBeTruthy();
    expect(screen.queryByText(/Use fullscreen/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Fullscreen graph" })).toBeNull();
  });

  it("hides small canvas links without changing full exposure or keyboard access", () => {
    const edges = [{ ...DEPENDENCY_EDGES[1], weight: 0.000148 }];
    const { container } = render(<ContagionGraph cards={CARDS} dependencyEdges={edges} mcapMap={MCAP_MAP} />);
    const picker = screen.getByRole("combobox", { name: "Inspect dependency" });
    expect(container.querySelectorAll('svg line[stroke="transparent"]')).toHaveLength(0);
    picker.focus();
    expect(document.activeElement).toBe(picker);
    fireEvent.change(picker, { target: { value: "0" } });
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("<1%");
    fireEvent.focus(screen.getByRole("button", { name: /USDe, Grade A/ }));
    const exposureBefore = screen.getAllByText("Direct dependent exposure").map(label => label.nextElementSibling?.textContent);
    expect(exposureBefore).toEqual(["$8.9M", "$8.9M"]);
    fireEvent.click(screen.getByRole("button", { name: /1 small links hidden/ }));
    expect(container.querySelectorAll('svg line[stroke="transparent"]')).toHaveLength(1);
    expect(screen.getAllByText("Direct dependent exposure").map(label => label.nextElementSibling?.textContent)).toEqual(exposureBefore);
    fireEvent.click(screen.getByRole("button", { name: /Hide 1 small links/ }));
    expect(container.querySelectorAll('svg line[stroke="transparent"]')).toHaveLength(0);
    expect(screen.getAllByText("Direct dependent exposure").map(label => label.nextElementSibling?.textContent)).toEqual(exposureBefore);
  });

  it("omits percentages on basket links with unavailable shares", () => {
    const edges: ReportCardsV9DependencyEdge[] = [{ ...DEPENDENCY_EDGES[1], weight: null, materiality: "basket-bounded-unknown" }];
    const { container } = render(<ContagionGraph cards={CARDS} dependencyEdges={edges} mcapMap={MCAP_MAP} />);
    fireEvent.mouseEnter(container.querySelector('svg line[stroke="transparent"]')!);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("upstream not rateable");
    expect(container.querySelector('[aria-live="polite"]')?.textContent).not.toContain("%");
  });

  it("announces keyboard edge inspection and subsequent filter results", () => {
    const edges: ReportCardsV9DependencyEdge[] = [{ ...DEPENDENCY_EDGES[1], materiality: "basket-bounded-unknown" }];
    render(<ContagionGraph cards={CARDS} dependencyEdges={edges} mcapMap={MCAP_MAP} />);
    const picker = screen.getByRole("combobox", { name: "Inspect dependency" });
    const filterRegion = screen.getByLabelText("Graph filter announcements");
    const filterBeforeInspection = filterRegion.textContent;
    picker.focus();
    fireEvent.change(picker, { target: { value: "0" } });
    const liveRegion = screen.getByLabelText("Dependency inspection announcements");
    expect(document.activeElement).toBe(picker);
    expect(liveRegion?.textContent).toContain("USDC depends on USDe");
    expect(liveRegion?.textContent).toContain("80%");
    expect(liveRegion?.textContent).toContain("upstream not rateable");
    expect(liveRegion.textContent).not.toContain("Filter results");
    expect(filterRegion.textContent).toBe(filterBeforeInspection);
    expect(filterRegion.textContent).not.toContain("80%");
    fireEvent.click(screen.getByRole("button", { name: "Wrapper" }));
    expect(filterRegion.textContent).toContain("0 connections");
    expect(liveRegion.textContent).toBe("");
    expect(within(picker).queryByRole("option", { name: /USDC depends on USDe/ })).toBeNull();
  });
  it("announces the effective detail limit rather than the unused control default", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} maxNodes={2} minimalChrome />);
    const filterRegion = screen.getByLabelText("Graph filter announcements");
    expect(filterRegion.textContent).toContain("limit 2.");
    expect(filterRegion.textContent).not.toContain("limit 200.");
    expect(filterRegion.textContent).toContain("2 stablecoins");
  });
  it("keeps full direct exposure and counts when a type filter hides dependents", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES.slice(0, 2)} mcapMap={MCAP_MAP} />);
    fireEvent.click(screen.getByRole("button", { name: /USDe, Grade A/ }));
    expect(screen.getAllByText("$48.0B")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Wrapper" }));
    expect(screen.getAllByText("$48.0B")).toHaveLength(2);
    expect(screen.getAllByText("1 (0 visible)")).toHaveLength(2);
  });

  it("mounts one live graph in fullscreen and restores the opener on close", async () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen graph" }));
    expect(document.querySelectorAll('[role="figure"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(2);
    expect(screen.getAllByLabelText("Dependency inspection announcements")).toHaveLength(1);
    expect(screen.getAllByLabelText("Graph filter announcements")).toHaveLength(1);
    expect(document.querySelectorAll("#clip-n-usdc-circle")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Close dependency map" })).toBeTruthy();
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "fullscreen_open", value: "graph" });
    fireEvent.click(screen.getByRole("button", { name: "Close dependency map" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fullscreen graph" })));
  });

  it("closes fullscreen when the viewport enters desktop", async () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);
    fireEvent.click(screen.getByRole("button", { name: "Fullscreen graph" }));
    desktop = true;
    act(() => mediaListener?.());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelectorAll('[role="figure"]')).toHaveLength(1);
  });

  it("shows unavailable market cap in the node label, announcement and inspection rail", () => {
    const mcaps = new Map<string, number | null>(MCAP_MAP);
    mcaps.set("usdc-circle", null);
    const { container } = render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={mcaps} />);
    fireEvent.focus(screen.getByRole("button", { name: /USDC, Grade A, mcap n\/a/ }));
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("mcap n/a");
    expect(screen.getAllByText("mcap n/a").length).toBeGreaterThan(0);
  });

  it("disambiguates collision identities in picker and accessible node labels", () => {
    const cards: ContagionGraphCard[] = [
      { id: "dusd-alto", symbol: "DUSD", grade: "B" },
      { id: "dusd-dialectic", symbol: "DUSD", grade: "B" },
    ];
    render(<ContagionGraph cards={cards} dependencyEdges={[{ ...DEPENDENCY_EDGES[1], from: "dusd-alto", to: "dusd-dialectic" }]} mcapMap={new Map()} />);
    expect(screen.getByRole("option", { name: "DUSD (Alto DUSD)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "DUSD (Dialectic USD)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /DUSD \(Alto DUSD\), Grade B/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /DUSD \(Dialectic USD\), Grade B/ })).toBeTruthy();
  });

  it("counts hubs only in the visible neighborhood", () => {
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} />);
    fireEvent.change(getTraceCoinPicker(), { target: { value: "usdtb-ethena" } });
    const { nodes, links } = buildGraphData(CARDS, MCAP_MAP, DEPENDENCY_EDGES);
    const tiers = buildSupernodeState(nodes, links).tierById;
    const visible = new Set(["usdtb-ethena", "usde-ethena"]);
    const expected = nodes.filter((node) => visible.has(node.id) && (tiers.get(node.id) ?? 0) > 0).length;
    expect(screen.getAllByText("Hubs").find((element) => element.tagName === "P")?.nextElementSibling?.textContent).toBe(String(expected));
  });

  it("round-trips URL controls and keeps unrelated parameters", async () => {
    window.history.replaceState(null, "", "/dependency-map/?focus=usde-ethena&utm_source=detail");
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} syncUrlState />);
    expect(getTraceCoinPicker().value).toBe("usde-ethena");
    expect(screen.getByRole("button", { name: "Selected neighborhood" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Wrapper" }));
    fireEvent.click(screen.getByRole("button", { name: "50" }));
    fireEvent.change(getTraceCoinPicker(), { target: { value: "usdc-circle" } });
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(Object.fromEntries(params)).toEqual({ focus: "neighborhood", type: "wrapper", limit: "50", trace: "usdc-circle", utm_source: "detail" });
    });
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "type", value: "wrapper" });
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "limit", value: "50" });
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "trace", value: "usdc-circle" });
    fireEvent.click(within(screen.getByRole("group", { name: "Graph focus mode" })).getByRole("button", { name: "All" }));
    expect(trackEvent).toHaveBeenCalledWith("dependency_map_action", { action: "focus", value: "all" });
  });

  it("ignores invalid URL controls and never syncs detail snapshots", () => {
    window.history.replaceState(null, "", "/dependency-map/?focus=missing&type=nope&limit=17&trace=missing&campaign=keep");
    const { unmount } = render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} syncUrlState />);
    expect(within(screen.getByRole("group", { name: "Graph focus mode" })).getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
    expect(new URLSearchParams(window.location.search).get("limit")).toBe("200");
    unmount();
    window.history.replaceState(null, "", "/stablecoin/usdc-circle/?focus=usde-ethena");
    render(<ContagionGraph cards={CARDS} dependencyEdges={DEPENDENCY_EDGES} mcapMap={MCAP_MAP} minimalChrome syncUrlState />);
    expect(window.location.search).toBe("?focus=usde-ethena");
    expect(trackEvent).not.toHaveBeenCalled();
  });
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
