// @vitest-environment jsdom

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  assertContentTableRowsMatchColumns,
  ContentTable,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { DataTableShell } from "@/components/data-table-shell";
import { SortableTableHead } from "@/components/sortable-table-head";
import { TablePagination } from "@/components/table-pagination";
import { TableSourceLink } from "@/components/table/client";

type FrameProps = Omit<React.ComponentProps<typeof TableFrame>, "children">;

function renderFrame(props: FrameProps = {}, cell = "USDT", header?: string) {
  return render(
    <TableFrame {...props}>
      {header && <TableHeader><TableRow><TableHead scope="col">{header}</TableHead></TableRow></TableHeader>}
      <TableBody><TableRow><TableCell>{cell}</TableCell></TableRow></TableBody>
    </TableFrame>,
  );
}

describe("Pharos table primitives", () => {
  it("renders a table frame with the shared surface, viewport, and data slots", () => {
    renderFrame({
      tableId: "stablecoin-overview",
      density: "compact",
      striped: true,
      topSlot: <div>Toolbar</div>,
      footerSlot: <div>Footer</div>,
    }, "USDC", "Name");

    const table = screen.getByRole("table");
    const shell = screen.getByTestId("stablecoin-overview-table");
    const viewport = table.parentElement;

    expect(shell.getAttribute("data-table-id")).toBe("stablecoin-overview");
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(table.querySelector("[data-slot='table-header']")).toBeTruthy();
    expect(table.querySelector("[data-slot='table-body']")).toBeTruthy();
    expect(table.getAttribute("aria-label")).toBe("Stablecoin Overview table");
    expect(screen.getByText("Name").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("USDC").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
    expect(screen.getByText("Toolbar")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
  });

  it("renders caption and label props through the base table frame", () => {
    renderFrame({
      tableId: "methodology-reference",
      caption: "Methodology reference",
      testId: "reference-surface",
      tableAriaLabel: "Reference table",
      chrome: "content",
      density: "compact",
      viewportProps: { mobileScrollHint: false },
    }, "Safety", "Metric");

    const shell = screen.getByTestId("reference-surface");
    const table = screen.getByRole("table", { name: "Reference table" });
    expect(shell.getAttribute("data-table-id")).toBe("methodology-reference");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(table.getAttribute("aria-label")).toBe("Reference table");
    expect(screen.getByText("Methodology reference").getAttribute("data-slot")).toBe("table-caption");
  });

  it("passes region props to the surface and viewport props to the scroll area", () => {
    renderFrame({
      role: "region",
      "aria-label": "Coverage matrix region",
      tabIndex: 0,
      viewportProps: { "aria-label": "Scrollable coverage matrix", mobileScrollHint: false },
    });

    const surface = screen.getByRole("region", { name: "Coverage matrix region" });
    const viewport = surface.querySelector("[data-slot='table-viewport']");
    expect(surface.getAttribute("tabindex")).toBe("0");
    expect(viewport?.getAttribute("aria-label")).toBe("Scrollable coverage matrix");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
  });

  it("renders a compact content table from column and row definitions", () => {
    render(
      <ContentTable
        tableId="methodology-example"
        caption="Condition band meanings"
        columns={[{ id: "name", header: "Name", rowHeader: true }, { id: "meaning", header: "Meaning" }]}
        rows={[{ id: "bedrock", cells: { name: "BEDROCK", meaning: "Near-ideal market stability" } }]}
      />,
    );

    expect(screen.getByTestId("methodology-example-table").getAttribute("data-table-id")).toBe("methodology-example");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(screen.getByText("Name").closest("th")?.getAttribute("scope")).toBe("col");
    expect(screen.getByRole("table", { name: "Condition band meanings" })).toBeTruthy();
    expect(screen.getByText("BEDROCK").closest("th")?.getAttribute("scope")).toBe("row");
    expect(screen.getByText("BEDROCK").closest("tr")?.getAttribute("data-row-intent")).toBe("static");
  });

  it("supports rowHeaderColumnId and rejects unknown row-header column ids or mismatched cells", () => {
    const columns = [{ id: "code", header: "Code" }, { id: "meaning", header: "Meaning" }];
    const rows = [{ id: "bedrock", cells: { code: "BEDROCK", meaning: "Near-ideal" } }];
    render(<ContentTable tableId="methodology-row-header-id" columns={columns} rows={rows} rowHeaderColumnId="code" />);

    expect(screen.getByText("BEDROCK").closest("th")?.getAttribute("scope")).toBe("row");
    expect(() => assertContentTableRowsMatchColumns(columns, rows, "typo")).toThrow(/Unknown rowHeaderColumnId: typo/);
    expect(() => assertContentTableRowsMatchColumns(columns, [{ id: "missing", cells: { code: "BEDROCK" } }]))
      .toThrow(/missing cells: meaning/);
    expect(() => assertContentTableRowsMatchColumns(columns, [{ id: "extra", cells: { code: "BEDROCK", meaning: "Stable", typo: "x" } }]))
      .toThrow(/extra cells: typo/);
  });

  it("renders source links with external-link metadata and can stop row propagation", () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <TableSourceLink href="https://example.com/source" stopPropagation>Source</TableSourceLink>
      </div>,
    );
    const link = screen.getByRole("link", { name: "Source" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("forwards viewportRef, ref, and surfaceRef and keeps composed refs stable across rerenders", () => {
    const vpObjRef = React.createRef<HTMLDivElement>();
    const ref = React.createRef<HTMLDivElement>();
    const surfaceObjRef = React.createRef<HTMLDivElement>();
    const { unmount } = renderFrame({
      ref,
      surfaceRef: surfaceObjRef,
      viewportDefaults: "virtual",
      testId: "virtual-shell",
      viewportProps: { ref: vpObjRef, mobileScrollHint: false },
    });
    expect(vpObjRef.current).toBe(screen.getByRole("table").parentElement);
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    const initialShell = screen.getByTestId("virtual-shell");
    expect(ref.current).toBe(initialShell);
    expect(surfaceObjRef.current).toBe(initialShell);
    unmount();

    const surfaceCalls: Array<HTMLDivElement | null> = [];
    const viewportCalls: Array<HTMLDivElement | null> = [];
    const surfaceRef = (node: HTMLDivElement | null) => { surfaceCalls.push(node); };
    const viewportRef = (node: HTMLDivElement | null) => { viewportCalls.push(node); };
    const view = renderFrame({
      viewportDefaults: "virtual",
      surfaceRef,
      viewportRef,
      testId: "virtual-shell",
      topSlot: <div>First toolbar</div>,
    });
    const shell = screen.getByTestId("virtual-shell");
    const viewport = screen.getByRole("table").parentElement as HTMLDivElement;
    expect(surfaceCalls).toEqual([shell]);
    expect(viewportCalls).toEqual([viewport]);

    view.rerender(
      <TableFrame viewportDefaults="virtual" surfaceRef={surfaceRef} viewportRef={viewportRef} testId="virtual-shell" topSlot={<div>Updated toolbar</div>}>
        <TableBody><TableRow><TableCell>USDC</TableCell></TableRow></TableBody>
      </TableFrame>,
    );
    expect(screen.getByText("Updated toolbar")).toBeTruthy();
    expect(surfaceCalls).toEqual([shell]);
    expect(viewportCalls).toEqual([viewport]);
  });

  it("defaults TableRow to scan, switches to interactive on onClick, and forces static inside TableHeader", () => {
    render(
      <TableFrame tableId="intent-check">
        <TableHeader><TableRow><TableHead>Coin</TableHead></TableRow></TableHeader>
        <TableBody>
          <TableRow><TableCell>Read-only row</TableCell></TableRow>
          <TableRow onClick={vi.fn()}><TableCell>Clickable row</TableCell></TableRow>
        </TableBody>
      </TableFrame>,
    );
    expect(screen.getByText("Coin").closest("tr")!.getAttribute("data-row-intent")).toBe("static");
    expect(screen.getByText("Read-only row").closest("tr")!.getAttribute("data-row-intent")).toBe("scan");
    expect(screen.getByText("Clickable row").closest("tr")!.getAttribute("data-row-intent")).toBe("interactive");
  });

  it("supports page-level sticky headers by default and viewport sticky headers when requested", () => {
    const shellEl = (stickyMode?: "page" | "viewport") => (
      <DataTableShell tableId="sticky-check" columns={[{ id: "name", label: "Name" }]} stickyHeader stickyMode={stickyMode}>
        <TableRow><TableCell>USDC</TableCell></TableRow>
      </DataTableShell>
    );
    const { rerender } = render(shellEl());
    const pageShell = screen.getByTestId("sticky-check-table");
    const pageViewport = pageShell.querySelector("[data-slot='table-viewport']")!;
    expect(pageShell.getAttribute("data-sticky-mode")).toBe("page");
    expect(pageViewport.getAttribute("data-sticky-mode")).toBe("page");
    expect(pageViewport.getAttribute("data-scroll-x")).toBe("responsive");

    rerender(shellEl("viewport"));
    expect(screen.getByTestId("sticky-check-table").getAttribute("data-sticky-mode")).toBe("viewport");
  });

  it("exposes aria-sort and triggers toggleSort on SortableTableHead", () => {
    const toggleSort = vi.fn();
    render(
      <table><thead><tr>
        <SortableTableHead sortKey="mcap" currentSortKey="mcap" sortDirection="desc" label="Market cap" toggleSort={toggleSort} getAriaSortValue={() => "descending"} />
        <SortableTableHead sortKey="price" currentSortKey="mcap" sortDirection="desc" label="Price" toggleSort={toggleSort} getAriaSortValue={() => "none"} />
      </tr></thead></table>,
    );
    const activeBtn = screen.getByRole("button", { name: "Sort by Market cap" });
    const inactiveBtn = screen.getByRole("button", { name: "Sort by Price" });
    expect(activeBtn.closest("th")?.getAttribute("aria-sort")).toBe("descending");
    expect(inactiveBtn.closest("th")?.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(inactiveBtn);
    expect(toggleSort).toHaveBeenCalledWith("price");
  });

  it("renders a Page X of Y indicator alongside pagination controls", () => {
    render(<TablePagination page={1} totalPages={5} rangeStart={21} rangeEnd={40} total={95} onPrevious={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByText("Page 2 of 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeTruthy();
  });

  it("marks page-sticky TableViewport horizontally scrollable when the table exceeds viewport width and clears once it fits", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let triggerResize: (() => void) | null = null;
    const observed: Element[] = [];
    class MockResizeObserver {
      constructor(private readonly cb: ResizeObserverCallback) {
        triggerResize = () => this.cb([], this as unknown as ResizeObserver);
      }
      observe(target: Element) { observed.push(target); }
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    try {
      renderFrame({ tableId: "wide-page-sticky", stickyHeader: true, stickyMode: "page" }, "USDC", "Coin");
      const table = screen.getByRole("table");
      const viewport = table.parentElement as HTMLDivElement;
      expect(observed).toContain(viewport);
      expect(observed).toContain(table);

      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 1000 });
      Object.defineProperty(table, "scrollWidth", { configurable: true, value: 1180 });
      act(() => { triggerResize?.(); });
      expect(viewport.getAttribute("data-scroll-x")).toBe("true");

      Object.defineProperty(table, "scrollWidth", { configurable: true, value: 980 });
      act(() => { triggerResize?.(); });
      expect(viewport.getAttribute("data-scroll-x")).toBeNull();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
