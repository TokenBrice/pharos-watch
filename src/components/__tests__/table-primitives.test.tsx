// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";

describe("Pharos table primitives", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a table frame with the shared surface, viewport, and data slots", () => {
    render(
      <TableFrame
        tableId="test-table"
        testId="test-table-shell"
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
    const shell = screen.getByTestId("test-table-shell");
    const viewport = table.parentElement;

    expect(shell.getAttribute("data-table-id")).toBe("test-table");
    expect(shell.className).toContain("pharos-table-shell");
    expect(shell.className).toContain("custom-shell");
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("pharos-table-striped");
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(table.className).toContain("min-w-[480px]");
    expect(screen.getByText("Name").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("USDC").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
    expect(screen.getByText("Toolbar")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
  });

  it("can suppress the mobile scroll hint", () => {
    render(
      <TableFrame viewportProps={{ mobileScrollHint: false }}>
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
  });
});
