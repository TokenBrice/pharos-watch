// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TableToolbar } from "@/components/table-toolbar";
import type { ColumnId } from "@/hooks/use-preferences";

function Toolbar({ onExport, exportDisabled = false }: { onExport: () => void; exportDisabled?: boolean }) {
  const [density, setDensity] = useState<"spacious" | "compact">("spacious");
  const [columns, setColumns] = useState<ColumnId[]>(["name", "price"]);
  const [search, setSearch] = useState("");
  return <TableToolbar density={density} onDensityChange={setDensity}
    visibleColumns={columns} onVisibleColumnsChange={setColumns}
    onResetColumns={() => setColumns(["name", "price"])} defaultColumns={["name", "price"]}
    onExport={onExport} exportDisabled={exportDisabled} searchValue={search} onSearchChange={setSearch} />;
}

describe("TableToolbar", () => {
  it("updates search, density, column visibility and restores defaults", async () => {
    render(<Toolbar onExport={vi.fn()} />);
    const search = screen.getByRole("searchbox", { name: "Search stablecoins" });
    fireEvent.change(search, { target: { value: "USDC" } });
    expect((search as HTMLInputElement).value).toBe("USDC");
    fireEvent.click(screen.getByRole("radio", { name: "Compact rows" }));
    expect(screen.getByRole("radio", { name: "Compact rows" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Spacious rows" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Columns" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Price", exact: true }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Price", exact: true }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Reset to defaults" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Price", exact: true }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("menuitemcheckbox", { name: "Reset to defaults" })).toBeNull();
  });

  it("exports only while enabled", () => {
    const onExport = vi.fn();
    const { rerender } = render(<Toolbar onExport={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    rerender(<Toolbar onExport={onExport} exportDisabled />);
    expect((screen.getByRole("button", { name: "Export CSV" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });
});
