// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useRowCursor } from "@/hooks/use-row-cursor";
import { cleanupFrontendTest } from "@/test-utils/frontend";

const rows = [{ id: "first" }, { id: "second" }];

function CursorHarness({ onOpen, onStar, onCompare }: {
  onOpen: (row: { id: string }) => void;
  onStar: (row: { id: string }) => void;
  onCompare: (row: { id: string }) => void;
}) {
  const scopeRef = useRef<HTMLDivElement>(null);
  const cursor = useRowCursor({ rows, getRowId: (row) => row.id, scopeRef, onOpen, onToggleStar: onStar, onAddToCompare: onCompare });
  return (
    <div ref={scopeRef}>
      <div data-testid="row" tabIndex={0}>Row {cursor.cursorId}</div>
      <button><span data-testid="button-child">Next</span></button>
      <a href="#destination"><svg data-testid="link-icon" /></a>
      <input aria-label="Filter" />
      <div contentEditable suppressContentEditableWarning><span data-testid="editable-child">Edit</span></div>
      <div role="button" tabIndex={0}>Custom control</div>
    </div>
  );
}

afterEach(cleanupFrontendTest);

describe("useRowCursor keyboard ownership", () => {
  it("preserves row navigation, open, star and compare shortcuts on a non-interactive row", () => {
    const onOpen = vi.fn();
    const onStar = vi.fn();
    const onCompare = vi.fn();
    render(<CursorHarness onOpen={onOpen} onStar={onStar} onCompare={onCompare} />);
    const row = screen.getByTestId("row");
    row.focus();
    fireEvent.keyDown(row, { key: "j" });
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: "s" });
    fireEvent.keyDown(row, { key: "c" });
    expect(onOpen).toHaveBeenCalledWith(rows[1]);
    expect(onStar).toHaveBeenCalledWith(rows[1]);
    expect(onCompare).toHaveBeenCalledWith(rows[1]);
    fireEvent.keyDown(row, { key: "k" });
    fireEvent.keyDown(row, { key: "o" });
    expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
  });

  it("does not cancel or act on keys from native controls, nested icons or editable ancestors", () => {
    const onOpen = vi.fn();
    const onStar = vi.fn();
    const onCompare = vi.fn();
    render(<CursorHarness onOpen={onOpen} onStar={onStar} onCompare={onCompare} />);
    const targets = [
      screen.getByTestId("button-child"), screen.getByTestId("link-icon"),
      screen.getByLabelText("Filter"), screen.getByTestId("editable-child"),
      screen.getByRole("button", { name: "Custom control" }),
    ];
    for (const target of targets) {
      (target.closest("button, a, input, [contenteditable], [role=button]") as HTMLElement).focus();
      for (const key of ["Enter", "j", "k", "s", "c", "o", "ArrowDown", "ArrowUp"]) {
        expect(fireEvent.keyDown(target, { key })).toBe(true);
      }
    }
    expect(onOpen).not.toHaveBeenCalled();
    expect(onStar).not.toHaveBeenCalled();
    expect(onCompare).not.toHaveBeenCalled();
    expect(screen.getByTestId("row").textContent).toBe("Row first");
  });
});
