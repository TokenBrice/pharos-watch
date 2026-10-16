// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataTableShell } from "@/components/data-table-shell";

describe("DataTableShell", () => {
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
});
