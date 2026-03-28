// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TableToolbar } from "@/components/table-toolbar";

describe("TableToolbar", () => {
  it("keeps the title block stacked until xl widths", () => {
    render(
      <TableToolbar
        density="comfortable"
        onDensityChange={vi.fn()}
        visibleColumns={["name", "price"]}
        onVisibleColumnsChange={vi.fn()}
        onResetColumns={vi.fn()}
        defaultColumns={["name", "price"]}
        onExport={vi.fn()}
      />,
    );

    const titleBlock = screen.getByText("Table Controls").parentElement;
    const layoutRow = titleBlock?.parentElement;

    expect(layoutRow?.classList.contains("xl:flex-row")).toBe(true);
    expect(layoutRow?.classList.contains("xl:items-start")).toBe(true);
    expect(layoutRow?.classList.contains("xl:justify-between")).toBe(true);
    expect(layoutRow?.classList.contains("sm:flex-row")).toBe(false);

    expect(titleBlock?.classList.contains("xl:flex-1")).toBe(true);
    expect(titleBlock?.classList.contains("flex-1")).toBe(false);
  });
});
