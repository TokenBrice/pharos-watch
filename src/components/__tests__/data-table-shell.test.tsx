// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";

const columns: readonly DataTableColumn[] = [{ id: "name", label: "Name" }] as const;

describe("DataTableShell", () => {
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
});
