// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InteractiveTableRow } from "@/components/interactive-table-row";

describe("InteractiveTableRow", () => {
  it("defaults focusable rows to button semantics with an action name", () => {
    const onActivate = vi.fn();

    render(
      <table>
        <tbody>
          <InteractiveTableRow onActivate={onActivate} ariaLabel="Expand USDT yield history">
            <td>USDT</td>
          </InteractiveTableRow>
        </tbody>
      </table>,
    );

    const row = screen.getByRole("button", { name: "Expand USDT yield history" });
    fireEvent.keyDown(row, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("passes link semantics and expanded state through to table row callers", () => {
    render(
      <table>
        <tbody>
          <InteractiveTableRow
            onActivate={() => {}}
            role="link"
            ariaLabel="Open USDC liquidity detail"
            ariaControls="usdc-panel"
            ariaExpanded
          >
            <td>USDC</td>
          </InteractiveTableRow>
        </tbody>
      </table>,
    );

    const row = screen.getByRole("link", { name: "Open USDC liquidity detail" });
    expect(row.getAttribute("aria-controls")).toBe("usdc-panel");
    expect(row.getAttribute("aria-expanded")).toBe("true");
  });

  it("activates once for click and Space, but not other keys or hover", () => {
    const onActivate = vi.fn();
    const onHover = vi.fn();
    render(<table><tbody><InteractiveTableRow onActivate={onActivate} onHover={onHover} ariaLabel="Open coin"><td>Coin</td></InteractiveTableRow></tbody></table>);
    const row = screen.getByRole("button", { name: "Open coin" });
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledTimes(1);
    onActivate.mockClear();
    expect(fireEvent.keyDown(row, { key: " ", cancelable: true })).toBe(false);
    expect(onActivate).toHaveBeenCalledTimes(1);
    onActivate.mockClear();
    expect(fireEvent.keyDown(row, { key: "ArrowDown", cancelable: true })).toBe(true);
    fireEvent.focus(row);
    expect(onHover).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(row);
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
