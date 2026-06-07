// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  DataTableEmptyRow,
  DataTableLoadingRows,
  DataTableShell,
  type DataTableColumn,
} from "@/components/data-table-shell";

const columns: readonly DataTableColumn[] = [{ id: "name", label: "Name" }] as const;

describe("DataTableShell", () => {
  afterEach(() => {
    cleanup();
  });

  it("preserves the children-first table frame contract", () => {
    render(
      <DataTableShell
        columns={[
          { id: "name", label: "Name" },
          {
            id: "marketCap",
            label: "Market Cap",
            className: "text-right",
            title: "Market capitalization",
          },
        ]}
        topSlot={<button type="button">Export rows</button>}
        mobileScrollHint={<span>Swipe matrix</span>}
        containerClassName="custom-shell"
        tableClassName="min-w-[720px]"
        headerClassName="sticky top-0"
        tableId="stablecoin-overview"
        testId="stablecoin-overview-table"
        striped
        density="compact"
        pagination={{
          page: 0,
          totalPages: 3,
          rangeStart: 1,
          rangeEnd: 1,
          total: 3,
          noun: "rows",
        }}
      >
        <tr data-testid="custom-row">
          <td>USDC</td>
          <td className="text-right">$75.5B</td>
        </tr>
      </DataTableShell>,
    );

    const table = screen.getByRole("table");
    const shell = table.closest(".pharos-table-shell");
    const row = screen.getByTestId("custom-row");
    const marketCapHeader = screen.getByText("Market Cap").closest("th");
    const viewport = table.parentElement;

    expect(shell?.className).toContain("custom-shell");
    expect(shell?.className).toContain("pharos-table-striped");
    expect(shell?.className).toContain("pharos-density-compact");
    expect(shell?.getAttribute("data-table-id")).toBe("stablecoin-overview");
    expect(screen.getByTestId("stablecoin-overview-table")).toBe(shell);
    expect(viewport?.getAttribute("data-slot")).toBe("table-viewport");
    expect(viewport?.querySelector("[data-slot='table-container']")).toBeNull();
    expect(table.className).toContain("min-w-[720px]");
    expect(table.querySelector("[data-slot='table-header']")?.className).toContain("sticky top-0");
    expect(row.parentElement?.getAttribute("data-slot")).toBe("table-body");
    expect(marketCapHeader?.className).toContain("text-right");
    expect(marketCapHeader?.getAttribute("title")).toBe("Market capitalization");
    expect(screen.getByRole("button", { name: "Export rows" })).toBeTruthy();
    expect(screen.getByText("Swipe matrix")).toBeTruthy();
    const paginationStatus = document.querySelector("[aria-live='polite']");
    expect(paginationStatus?.textContent?.replace(/\s+/g, " ").trim()).toBe("Showing 1–1 of 3 rows");
    expect(screen.getByRole("button", { name: "Go to previous page" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("does not force-hide horizontal overflow at desktop breakpoints", () => {
    render(
      <DataTableShell columns={columns}>
        <tr>
          <td>USDT</td>
        </tr>
      </DataTableShell>,
    );

    const table = screen.getByRole("table");
    const scrollRegion = table.parentElement;

    expect(scrollRegion?.className).toContain("overflow-x-auto");
    expect(scrollRegion?.className).not.toContain("overflow-x-hidden");
    expect(scrollRegion?.className).not.toContain("lg:overflow-x-hidden");
  });

  it("preserves frame, viewport, table, top slot, hint, and pagination options", () => {
    render(
      <DataTableShell
        columns={columns}
        topSlot={<div>Toolbar</div>}
        mobileScrollHint="Scroll for more"
        containerClassName="custom-shell"
        tableClassName="min-w-[640px] custom-table"
        headerClassName="custom-header"
        density="compact"
        striped
        pagination={{
          page: 0,
          totalPages: 3,
          rangeStart: 1,
          rangeEnd: 1,
          total: 3,
          noun: "rows",
        }}
      >
        <tr>
          <td>USDT</td>
        </tr>
      </DataTableShell>,
    );

    const table = screen.getByRole("table");
    const shell = table.closest(".pharos-table-shell");
    const viewport = table.parentElement;

    expect(shell?.className).toContain("pharos-table-shell");
    expect(shell?.className).toContain("custom-shell");
    expect(shell?.className).toContain("pharos-table-striped");
    expect(shell?.className).toContain("pharos-density-compact");
    expect(viewport?.className).toContain("overflow-x-auto");
    expect(viewport?.className).toContain("pb-3");
    expect(screen.getByRole("table").className).toContain("custom-table");
    expect(screen.getByText("Name").closest("thead")?.className).toContain("custom-header");
    expect(screen.getByText("Toolbar")).toBeTruthy();
    expect(screen.getByText("Scroll for more")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to previous page" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeTruthy();
  });

  it("keeps sortable header adornments outside the native sort button", () => {
    render(
      <DataTableShell
        columns={[{
          id: "score",
          label: "Score",
          sortKey: "score",
          headerAdornment: <button type="button">Help</button>,
        }]}
        sort={{
          sortKey: "score",
          sortDirection: "desc",
          toggleSort: () => {},
          getAriaSortValue: () => "descending",
        }}
      >
        <tr>
          <td>95</td>
        </tr>
      </DataTableShell>,
    );

    const sortButton = screen.getByRole("button", { name: "Sort by Score" });
    const helpButton = screen.getByRole("button", { name: "Help" });

    expect(sortButton.contains(helpButton)).toBe(false);
    expect(sortButton.closest("th")?.contains(helpButton)).toBe(true);
  });

  it("renders shared empty and loading rows with the configured columns", () => {
    render(
      <DataTableShell columns={columns}>
        <DataTableLoadingRows columns={columns} rowCount={2} />
        <DataTableEmptyRow colSpan={columns.length}>No rows</DataTableEmptyRow>
      </DataTableShell>,
    );

    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("No rows").getAttribute("colspan")).toBe("1");
  });

  it("can suppress mobile hints and skip refresh subscriptions without a query client", () => {
    render(
      <DataTableShell
        columns={columns}
        mobileScrollHint={false}
        refreshingQueryKeys={[["stablecoins"]]}
        isPending={false}
      >
        <tr>
          <td>USDT</td>
        </tr>
      </DataTableShell>,
    );

    expect(screen.queryByText("Swipe sideways for more columns")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
  });
});
