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

  it("does not force-hide horizontal overflow at desktop breakpoints", () => {
    render(
      <DataTableShell columns={columns}>
        <tr>
          <td>USDT</td>
        </tr>
      </DataTableShell>,
    );

    const table = screen.getByRole("table");
    const shell = table.parentElement?.parentElement;

    expect(shell?.className).toContain("overflow-x-auto");
    expect(shell?.className).not.toContain("overflow-x-hidden");
    expect(shell?.className).not.toContain("lg:overflow-x-hidden");
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
});
