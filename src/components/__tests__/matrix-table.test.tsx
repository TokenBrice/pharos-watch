// @vitest-environment jsdom

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

describe("TableFrame matrix markup", () => {

  it("renders a caption and stable identity attributes", () => {
    render(
      <TableFrame
        tableId="coverage-matrix"
        testId="coverage-matrix-table"
        caption="Per-coin feature coverage"
        captionClassName="sr-only"
        tableAriaLabel="Coverage matrix"
      >
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Stablecoin</TableHead>
            <TableHead scope="col">Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>USDC</TableCell>
            <TableCell>Available</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const shell = screen.getByTestId("coverage-matrix-table");
    const table = screen.getByRole("table", { name: "Coverage matrix" });
    const caption = screen.getByText("Per-coin feature coverage");

    expect(shell.getAttribute("data-table-id")).toBe("coverage-matrix");
    expect(shell.className).toContain("pharos-table-shell");
    expect(table.getAttribute("aria-label")).toBe("Coverage matrix");
    expect(caption.getAttribute("data-slot")).toBe("table-caption");
    expect(caption.className).toContain("sr-only");
  });

  it("keeps semantic table data slots without the shadcn overflow wrapper", () => {
    render(
      <TableFrame>
        <TableHeader>
          <TableRow>
            <TableHead>Metric</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Safety</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const table = screen.getByRole("table");
    const viewport = table.parentElement;

    expect(table.getAttribute("data-slot")).toBe("table");
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.querySelector("[data-slot='table-header']")).toBeTruthy();
    expect(table.querySelector("[data-slot='table-body']")).toBeTruthy();
    expect(screen.getByText("Metric").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("Safety").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
  });

  it("passes region props to the surface and viewport props to the scroll area", () => {
    render(
      <TableFrame
        role="region"
        aria-label="Coverage matrix region"
        tabIndex={0}
        className="hidden md:block custom-surface"
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

    const surface = screen.getByRole("region", {
      name: "Coverage matrix region",
    });
    const viewport = surface.querySelector("[data-slot='table-viewport']");

    expect(surface.getAttribute("tabindex")).toBe("0");
    expect(surface.className).toContain("custom-surface");
    expect(viewport?.className).toContain("custom-viewport");
    expect(viewport?.getAttribute("aria-label")).toBe("Scrollable coverage matrix");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
  });

  it("preserves sticky-header, sticky-column, and fixed-layout classes", () => {
    render(
      <TableFrame
        stickyHeader
        tableClassName="min-w-[64rem] table-fixed"
      >
        <TableHeader className="bg-muted/22">
          <TableRow>
            <TableHead
              scope="col"
              className="pharos-table-sticky-metric min-w-[110px]"
            >
              Metric
            </TableHead>
            <TableHead scope="col" className="text-center min-w-[120px]">
              USDC
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell className="pharos-table-sticky-metric font-medium">
              Peg score
            </TableCell>
            <TableCell className="text-center">99</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    const table = screen.getByRole("table");
    const shell = table.closest(".pharos-table-shell");
    const stickyHead = screen.getByText("Metric").closest("th");
    const stickyCell = screen.getByText("Peg score").closest("td");

    expect(shell?.className).toContain("table-header-sticky");
    expect(table.className).toContain("min-w-[64rem]");
    expect(table.className).toContain("table-fixed");
    expect(stickyHead?.className).toContain("pharos-table-sticky-metric");
    expect(stickyCell?.className).toContain("pharos-table-sticky-metric");
  });
});
