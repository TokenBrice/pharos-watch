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

describe("Pharos table primitives", () => {

  it("renders a table frame with the shared surface, viewport, and data slots", () => {
    render(
      <TableFrame
        tableId="stablecoin-overview"
        className="custom-shell"
        tableClassName="min-w-[480px]"
        density="compact"
        striped
        topSlot={<div>Toolbar</div>}
        footerSlot={<div>Footer</div>}
      >
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>USDC</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const table = screen.getByRole("table");
    const shell = screen.getByTestId("stablecoin-overview-table");
    const viewport = table.parentElement;

    expect(shell.getAttribute("data-table-id")).toBe("stablecoin-overview");
    expect(shell.className).toContain("custom-shell");
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(table.querySelector("[data-slot='table-header']")).toBeTruthy();
    expect(table.querySelector("[data-slot='table-body']")).toBeTruthy();
    expect(table.getAttribute("aria-label")).toBe("Stablecoin Overview table");
    expect(table.className).toContain("min-w-[480px]");
    expect(screen.getByText("Name").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("USDC").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
    expect(screen.getByText("Toolbar")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
  });

  it("renders caption and label props through the base table frame", () => {
    render(
      <TableFrame
        tableId="methodology-reference"
        caption="Methodology reference"
        testId="reference-surface"
        captionClassName="sr-only"
        tableAriaLabel="Reference table"
        chrome="content"
        density="compact"
        viewportProps={{ mobileScrollHint: false }}
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Metric</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Safety</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const shell = screen.getByTestId("reference-surface");
    const table = screen.getByRole("table", { name: "Reference table" });

    expect(shell.getAttribute("data-table-id")).toBe("methodology-reference");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(table.getAttribute("aria-label")).toBe("Reference table");
    expect(screen.getByText("Methodology reference").getAttribute("data-slot")).toBe("table-caption");
    expect(
      screen.getByText("Methodology reference").closest("caption")?.className,
    ).toContain("sr-only");
  });

  it("passes region props to the surface and viewport props to the scroll area", () => {
    render(
      <TableFrame
        role="region"
        aria-label="Coverage matrix region"
        tabIndex={0}
        className="custom-surface"
        viewportClassName="custom-viewport"
        viewportProps={{
          "aria-label": "Scrollable coverage matrix",
          mobileScrollHint: false,
        }}
      >
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const surface = screen.getByRole("region", { name: "Coverage matrix region" });
    const viewport = surface.querySelector("[data-slot='table-viewport']");

    expect(surface.getAttribute("tabindex")).toBe("0");
    expect(surface.className).toContain("custom-surface");
    expect(viewport?.className).toContain("custom-viewport");
    expect(viewport?.getAttribute("aria-label")).toBe("Scrollable coverage matrix");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
  });


  it("renders a compact content table from column and row definitions", () => {
    render(
      <ContentTable
        tableId="methodology-example"
        caption="Condition band meanings"
        columns={[
          { id: "name", header: "Name", rowHeader: true },
          { id: "meaning", header: "Meaning", cellClassName: "whitespace-normal" },
        ]}
        rows={[
          {
            id: "bedrock",
            cells: { name: "BEDROCK", meaning: "Near-ideal market stability" },
            cellClassNames: { name: "text-green-700" },
          },
        ]}
      />,
    );

    const shell = screen.getByTestId("methodology-example-table");
    expect(shell.getAttribute("data-table-id")).toBe("methodology-example");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(screen.getByText("Name").closest("th")?.getAttribute("scope")).toBe("col");
    expect(
      screen.getByRole("table", { name: "Condition band meanings" }),
    ).toBeTruthy();
    expect(screen.getByText("BEDROCK").closest("th")?.getAttribute("scope")).toBe("row");
    expect(screen.getByText("BEDROCK").closest("th")?.className).toContain("text-green-700");
    expect(
      screen.getByText("BEDROCK").closest("tr")?.getAttribute("data-row-intent"),
    ).toBe("static");
  });

  it("supports rowHeaderColumnId and rejects unknown row-header column ids", () => {
    const columns = [
      { id: "code", header: "Code" },
      { id: "meaning", header: "Meaning" },
    ];
    const rows = [
      { id: "bedrock", cells: { code: "BEDROCK", meaning: "Near-ideal" } },
    ];

    render(
      <ContentTable
        tableId="methodology-row-header-id"
        columns={columns}
        rows={rows}
        rowHeaderColumnId="code"
      />,
    );

    expect(screen.getByText("BEDROCK").closest("th")?.getAttribute("scope")).toBe("row");
    expect(() => assertContentTableRowsMatchColumns(columns, rows, "typo")).toThrow(
      /Unknown rowHeaderColumnId: typo/,
    );
  });

  it("throws when content table row cell keys do not match declared columns", () => {
    const columns = [
      { id: "name", header: "Name" },
      { id: "meaning", header: "Meaning" },
    ];

    expect(() =>
      assertContentTableRowsMatchColumns(columns, [
        { id: "missing", cells: { name: "BEDROCK" } },
      ]),
    ).toThrow(/missing cells: meaning/);

    expect(() =>
      assertContentTableRowsMatchColumns(columns, [
        {
          id: "extra",
          cells: { name: "BEDROCK", meaning: "Stable", typo: "ignored" },
        },
      ]),
    ).toThrow(/extra cells: typo/);
  });

  it("renders source links with external-link metadata and can stop row propagation", () => {
    const onRowClick = vi.fn();

    render(
      <div onClick={onRowClick}>
        <TableSourceLink href="https://example.com/source" stopPropagation>
          Source
        </TableSourceLink>
      </div>,
    );

    const link = screen.getByRole("link", { name: "Source" });

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });
  it("accepts a viewport ref through viewportProps for virtualizer getScrollElement usage", () => {
    const viewportRef = React.createRef<HTMLDivElement>();

    render(
      <TableFrame
        viewportDefaults="virtual"
        viewportProps={{ ref: viewportRef, mobileScrollHint: false }}
      >
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const viewport = screen.getByRole("table").parentElement;

    expect(viewportRef.current).toBe(viewport);
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
  });

  it("forwards the standard ref prop along with surfaceRef", () => {
    const ref = React.createRef<HTMLDivElement>();
    const surfaceRef = React.createRef<HTMLDivElement>();

    render(
      <TableFrame ref={ref} surfaceRef={surfaceRef} viewportDefaults="virtual" testId="virtual-shell">
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const shell = screen.getByTestId("virtual-shell");
    expect(ref.current).toBe(shell);
    expect(surfaceRef.current).toBe(shell);
  });

  it("keeps composed refs stable across rerenders", () => {
    const surfaceCalls: Array<HTMLDivElement | null> = [];
    const viewportCalls: Array<HTMLDivElement | null> = [];
    const surfaceRef = (node: HTMLDivElement | null) => {
      surfaceCalls.push(node);
    };
    const viewportRef = (node: HTMLDivElement | null) => {
      viewportCalls.push(node);
    };

    const { rerender } = render(
      <TableFrame
        viewportDefaults="virtual"
        surfaceRef={surfaceRef}
        viewportRef={viewportRef}
        testId="virtual-shell"
        topSlot={<div>First toolbar</div>}
      >
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const shell = screen.getByTestId("virtual-shell");
    const viewport = screen.getByRole("table").parentElement as HTMLDivElement;

    expect(surfaceCalls).toEqual([shell]);
    expect(viewportCalls).toEqual([viewport]);

    rerender(
      <TableFrame
        viewportDefaults="virtual"
        surfaceRef={surfaceRef}
        viewportRef={viewportRef}
        testId="virtual-shell"
        topSlot={<div>Updated toolbar</div>}
      >
        <TableBody>
          <TableRow>
            <TableCell>USDC</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    expect(screen.getByText("Updated toolbar")).toBeTruthy();
    expect(surfaceCalls).toEqual([shell]);
    expect(viewportCalls).toEqual([viewport]);
  });

  it("defaults TableRow to scan, switches to interactive on onClick, forces static inside TableHeader, and clips fixed cells", () => {
    const onRowClick = vi.fn();
    render(
      <TableFrame tableId="intent-check" tableClassName="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead>Coin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Read-only row</TableCell>
          </TableRow>
          <TableRow onClick={onRowClick}>
            <TableCell>Clickable row</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const headerRow = screen.getByText("Coin").closest("tr")!;
    const scanRow = screen.getByText("Read-only row").closest("tr")!;
    const interactiveRow = screen.getByText("Clickable row").closest("tr")!;
    const cell = screen.getByText("Read-only row").closest("td")!;

    expect(headerRow.getAttribute("data-row-intent")).toBe("static");
    expect(scanRow.getAttribute("data-row-intent")).toBe("scan");
    expect(interactiveRow.getAttribute("data-row-intent")).toBe("interactive");
    expect(cell.className).toContain("overflow-hidden");
    expect(cell.className).toContain("text-ellipsis");
  });

  it("supports page-level sticky headers by default and viewport sticky headers when requested", () => {
    const { rerender } = render(
      <DataTableShell
        tableId="sticky-check"
        columns={[{ id: "name", label: "Name" }]}
        stickyHeader
      >
        <TableRow>
          <TableCell>USDC</TableCell>
        </TableRow>
      </DataTableShell>,
    );

    const pageShell = screen.getByTestId("sticky-check-table");
    const pageViewport = pageShell.querySelector("[data-slot='table-viewport']")!;
    expect(pageShell.getAttribute("data-sticky-mode")).toBe("page");
    expect(pageShell.className).toContain("overflow-clip");
    expect(pageShell.className).toContain("[--table-header-top:var(--sticky-header-bottom,3.75rem)]");
    expect(pageShell.className).toContain("[&_thead]:top-[var(--table-header-top,0px)]");
    expect(pageViewport.getAttribute("data-sticky-mode")).toBe("page");
    expect(pageViewport.getAttribute("data-scroll-x")).toBe("responsive");

    rerender(
      <DataTableShell
        tableId="sticky-check"
        columns={[{ id: "name", label: "Name" }]}
        stickyHeader
        stickyMode="viewport"
      >
        <TableRow>
          <TableCell>USDC</TableCell>
        </TableRow>
      </DataTableShell>,
    );

    const viewportShell = screen.getByTestId("sticky-check-table");
    const viewportEl = viewportShell.querySelector("[data-slot='table-viewport']")!;
    expect(viewportShell.getAttribute("data-sticky-mode")).toBe("viewport");
    expect(viewportEl.className).toContain("overflow-y-auto");
    expect(viewportEl.className).toContain("[--table-header-top:0px]");
  });

  it("highlights the active SortableTableHead without negative margins and dims inactive sort icons", () => {
    const toggleSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableTableHead
              sortKey="mcap"
              currentSortKey="mcap"
              sortDirection="desc"
              label="Market cap"
              toggleSort={toggleSort}
              getAriaSortValue={() => "descending"}
            />
            <SortableTableHead
              sortKey="price"
              currentSortKey="mcap"
              sortDirection="desc"
              label="Price"
              toggleSort={toggleSort}
              getAriaSortValue={() => "none"}
            />
          </tr>
        </thead>
      </table>,
    );

    const activeTh = screen.getByRole("button", { name: "Sort by Market cap" }).closest("th")!;
    const activeButton = screen.getByRole("button", { name: "Sort by Market cap" });
    const inactiveTh = screen.getByRole("button", { name: "Sort by Price" }).closest("th")!;
    const inactiveIcon = inactiveTh.querySelector("svg")!;

    expect(activeTh.className).toContain("text-foreground");
    expect(activeTh.className).toContain("shadow-[inset_0_-2px_0_0_var(--brand-accent)]");
    expect(activeButton.className).not.toContain("-ml-2");
    expect(activeButton.className).not.toContain("-mr-2");
    expect(inactiveIcon.getAttribute("class")).toContain("opacity-35");
  });

  it("renders a Page X of Y indicator alongside pagination controls", () => {
    render(
      <TablePagination
        page={1}
        totalPages={5}
        rangeStart={21}
        rangeEnd={40}
        total={95}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
      />,
    );

    expect(screen.getByText("Page 2 of 5")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeTruthy();
  });

  it("keeps page-sticky TableViewport horizontally scrollable when the table exceeds viewport width and restores overflow-visible once it fits", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let triggerResize: (() => void) | null = null;
    const observed: Element[] = [];

    class MockResizeObserver {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        triggerResize = () => this.callback([], this as unknown as ResizeObserver);
      }
      observe(target: Element) {
        observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }

    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    try {
      render(
        <TableFrame tableId="wide-page-sticky" stickyHeader stickyMode="page">
          <TableHeader>
            <TableRow>
              <TableHead>Coin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>USDC</TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>,
      );

      const table = screen.getByRole("table");
      const viewport = table.parentElement as HTMLDivElement;
      expect(observed).toContain(viewport);
      expect(observed).toContain(table);

      Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 1000 });
      Object.defineProperty(table, "scrollWidth", { configurable: true, value: 1180 });
      act(() => {
        triggerResize?.();
      });

      expect(viewport.className).toContain("overflow-x-auto");
      expect(viewport.className).toContain("scroll-shadow");
      expect(viewport.className).not.toContain("overflow-visible");
      expect(viewport.getAttribute("data-scroll-x")).toBe("true");
      expect(viewport.className).toContain("[--table-header-top:0px]");

      Object.defineProperty(table, "scrollWidth", { configurable: true, value: 980 });
      act(() => {
        triggerResize?.();
      });

      expect(viewport.className).toContain("overflow-visible");
      expect(viewport.className).not.toContain("overflow-x-auto");
      expect(viewport.className).not.toContain("scroll-shadow");
      expect(viewport.getAttribute("data-scroll-x")).toBeNull();
      expect(viewport.className).not.toContain("[--table-header-top:0px]");
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
