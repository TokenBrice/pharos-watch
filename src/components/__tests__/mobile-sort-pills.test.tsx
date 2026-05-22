// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileSortPills } from "@/components/mobile-sort-pills";

describe("MobileSortPills", () => {
  it("marks the active sort option and emits sort changes", () => {
    const onSort = vi.fn();

    render(
      <MobileSortPills
        options={[
          { key: "supply", label: "Supply" },
          { key: "peg", label: "Peg" },
        ]}
        sortKey="supply"
        sortDirection="desc"
        onSort={onSort}
        ariaLabel="Sort rows"
      />,
    );

    expect(screen.getByRole("group", { name: "Sort rows" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Supply/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("↓")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Peg" }));

    expect(onSort).toHaveBeenCalledWith("peg");
  });
});
