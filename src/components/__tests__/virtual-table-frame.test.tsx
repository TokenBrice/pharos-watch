// @vitest-environment jsdom

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";

describe("TableFrame virtual defaults", () => {

  it("composes shell identity, slots, viewport overflow, and table slots without a nested shadcn container", () => {
    const surfaceRef = React.createRef<HTMLDivElement>();
    const viewportRef = React.createRef<HTMLDivElement>();

    render(
      <TableFrame
        viewportDefaults="virtual"
        tableId="stablecoin-overview"
        testId="stablecoin-overview-shell"
        className="animate-in"
        tableClassName="min-w-[820px] table-fixed"
        viewportClassName="max-h-[70vh]"
        surfaceRef={surfaceRef}
        viewportRef={viewportRef}
        mobileScrollHint={<span>Risk cues stay visible in each row.</span>}
        topSlot={<div>Virtual toolbar</div>}
        footerSlot={<div>Virtual footer</div>}
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

    const shell = screen.getByTestId("stablecoin-overview-shell");
    const table = screen.getByRole("table", { name: "Stablecoin Overview table" });
    const viewport = table.parentElement;

    expect(shell.getAttribute("data-table-id")).toBe("stablecoin-overview");
    expect(shell.className).toContain("pharos-table-shell");
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("pharos-table-striped-indexed");
    expect(shell.className).toContain("animate-in");
    expect(surfaceRef.current).toBe(shell);
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.className).toContain("scroll-shadow");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.className).toContain("overflow-y-auto");
    expect(viewport?.className).toContain("overscroll-x-contain");
    expect(viewport?.className).toContain("max-h-[70vh]");
    expect(viewportRef.current).toBe(viewport);
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(table.className).toContain("min-w-[820px]");
    expect(table.className).toContain("table-fixed");
    expect(screen.getByText("Risk cues stay visible in each row.")).toBeTruthy();
    expect(screen.getByText("Virtual toolbar")).toBeTruthy();
    expect(screen.getByText("Virtual footer")).toBeTruthy();
    expect(shell.querySelector("[data-slot='table-container']")).toBeNull();
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
});
