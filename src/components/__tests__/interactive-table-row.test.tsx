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
});
