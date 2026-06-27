// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TableToolbar } from "@/components/table-toolbar";

describe("TableToolbar", () => {
  const defaultProps = {
    density: "spacious" as const,
    onDensityChange: vi.fn(),
    visibleColumns: ["name", "price"],
    onVisibleColumnsChange: vi.fn(),
    onResetColumns: vi.fn(),
    defaultColumns: ["name", "price"],
    onExport: vi.fn(),
  };

  it("keeps the title block stacked until xl widths", () => {
    render(
      <TableToolbar
        {...defaultProps}
      />,
    );

    const titleBlock = screen.getByText("Table Controls").parentElement;
    const layoutRow = titleBlock?.parentElement;

    expect(layoutRow?.classList.contains("xl:flex-row")).toBe(true);
    expect(layoutRow?.classList.contains("xl:items-baseline")).toBe(true);
    expect(layoutRow?.classList.contains("xl:justify-between")).toBe(true);
    expect(layoutRow?.classList.contains("sm:flex-row")).toBe(false);

    expect(titleBlock?.classList.contains("xl:flex-1")).toBe(true);
    expect(titleBlock?.classList.contains("flex-1")).toBe(false);
  });

  it("keeps overview search on the same toolbar line as table actions", () => {
    render(
      <TableToolbar
        {...defaultProps}
        variant="figmaOverview"
        searchValue=""
        onSearchChange={vi.fn()}
      />,
    );

    const search = screen.getByRole("searchbox", { name: "Search stablecoins" });
    const toolbar = search.closest(".pharos-overview-table-toolbar");

    expect(toolbar?.classList.contains("flex")).toBe(true);
    expect(toolbar?.classList.contains("flex-wrap")).toBe(true);
    const densityControl = toolbar?.querySelector('[role="radiogroup"][aria-label="Table density"]');
    expect(densityControl).toBeTruthy();
    expect(densityControl?.classList.contains("bg-muted/50")).toBe(true);
    expect(densityControl?.classList.contains("dark:bg-neutral-900")).toBe(true);
    expect(densityControl?.classList.contains("w-[84px]")).toBe(true);
    const activeDensity = densityControl?.querySelector('[role="radio"][aria-checked="true"]');
    expect(activeDensity?.classList.contains("bg-card")).toBe(true);
    expect(activeDensity?.classList.contains("dark:bg-neutral-700")).toBe(true);
    expect(toolbar?.textContent).toContain("Columns");
    expect(toolbar?.textContent).toContain("Export CSV");
  });
});
