// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  assertContentTableRowsMatchColumns,
  ContentTable,
  ContentTableFrame,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";

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
    expect(shell.className).toContain("pharos-table-shell");
    expect(shell.className).toContain("custom-shell");
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("pharos-table-striped");
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.getAttribute("data-slot")).toBe("table");
    expect(table.getAttribute("aria-label")).toBe("Stablecoin Overview table");
    expect(table.className).toContain("min-w-[480px]");
    expect(screen.getByText("Name").closest("th")?.getAttribute("data-slot")).toBe("table-head");
    expect(screen.getByText("USDC").closest("td")?.getAttribute("data-slot")).toBe("table-cell");
    expect(screen.getByText("Toolbar")).toBeTruthy();
    expect(screen.getByText("Footer")).toBeTruthy();
  });

  it("renders a children-first content table frame preset", () => {
    render(
      <ContentTableFrame
        tableId="methodology-reference"
        caption="Methodology reference"
        captionClassName="sr-only"
        tableAriaLabel="Reference table"
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
      </ContentTableFrame>,
    );

    const shell = screen.getByTestId("methodology-reference-table");
    const table = screen.getByRole("table", { name: "Reference table" });

    expect(shell.getAttribute("data-table-id")).toBe("methodology-reference");
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("rounded-xl");
    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(table.getAttribute("aria-label")).toBe("Reference table");
    expect(
      screen.getByText("Methodology reference").closest("caption")?.className,
    ).toContain("sr-only");
  });

  it("preserves explicit table labels over the table id fallback", () => {
    render(
      <TableFrame
        tableId="fallback-id"
        tableProps={{ "aria-label": "Explicit table label" }}
      >
        <TableBody>
          <TableRow>
            <TableCell>USDT</TableCell>
          </TableRow>
        </TableBody>
      </TableFrame>,
    );

    expect(screen.getByRole("table", { name: "Explicit table label" })).toBeTruthy();
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
    expect(shell.className).toContain("pharos-density-compact");
    expect(shell.className).toContain("rounded-xl");
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

  it("marks row intent without changing the default row behavior", () => {
    render(
      <table>
        <tbody>
          <TableRow>
            <TableCell>Default</TableCell>
          </TableRow>
          <TableRow rowIntent="static">
            <TableCell>Static</TableCell>
          </TableRow>
          <TableRow rowIntent="scan">
            <TableCell>Scan</TableCell>
          </TableRow>
        </tbody>
      </table>,
    );

    expect(
      screen.getByText("Default").closest("tr")?.getAttribute("data-row-intent"),
    ).toBe("interactive");
    expect(
      screen.getByText("Static").closest("tr")?.getAttribute("data-row-intent"),
    ).toBe("static");
    expect(
      screen.getByText("Scan").closest("tr")?.getAttribute("data-row-intent"),
    ).toBe("scan");
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
