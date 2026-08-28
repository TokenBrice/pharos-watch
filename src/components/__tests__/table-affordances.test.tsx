// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TableToolbarFrame } from "@/components/table";
import { TableSourceLink } from "@/components/table/client";

describe("table affordances", () => {

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
