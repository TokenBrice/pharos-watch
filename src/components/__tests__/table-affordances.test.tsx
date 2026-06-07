// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TableSettingsMenu, TableSourceLink, TableToolbarFrame } from "@/components/table";

describe("table affordances", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a generic toolbar frame with actions and no settings requirement", () => {
    render(
      <TableToolbarFrame
        eyebrow="Operational table"
        description="Compact rows"
        actions={<button type="button">Refresh</button>}
      />,
    );

    const titleBlock = screen.getByText("Operational table").parentElement;
    const layoutRow = titleBlock?.parentElement;

    expect(layoutRow?.className).toContain("xl:flex-row");
    expect(screen.getByText("Compact rows")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("renders optional density and column settings inside the shared settings menu", () => {
    const onDensityChange = vi.fn();

    render(
      <TableSettingsMenu
        density="comfortable"
        onDensityChange={onDensityChange}
        columnsSlot={<button type="button">Column picker</button>}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Table settings" }));

    expect(screen.getByText("Density")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Column picker" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    expect(onDensityChange).toHaveBeenCalledWith("compact");
  });

  it("renders density-only settings without requiring a column picker", () => {
    render(<TableSettingsMenu density="compact" onDensityChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Table settings" }));

    expect(screen.getByText("Density")).toBeTruthy();
    expect(screen.queryByText("Columns")).toBeNull();
  });

  it("renders source links with external-link metadata and can stop row propagation", () => {
    const onRowClick = vi.fn();

    render(
      <div onClick={onRowClick}>
        <TableSourceLink href="https://example.com/source" stopPropagation>
          Source
        </TableSourceLink>
      </div>,
    );

    const link = screen.getByRole("link", { name: "Source" });

    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.click(link);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("falls back to static text when a source link is missing", () => {
    render(<TableSourceLink href={null}>No source</TableSourceLink>);

    expect(screen.getByText("No source").tagName).toBe("SPAN");
    expect(screen.queryByRole("link", { name: "No source" })).toBeNull();
  });
});
