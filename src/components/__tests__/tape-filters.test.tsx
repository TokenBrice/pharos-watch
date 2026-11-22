// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TapeFilters, type TapeFilterState } from "@/components/tape/tape-filters";

const baseState: TapeFilterState = {
  typeRaw: "",
  type: [],
  severity: "notice",
  coin: "all",
  peg: "all",
  chain: "all",
  window: "7d",
  q: "",
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("TapeFilters search input", () => {
  it("adopts a URL-driven query change and commits typed text after the debounce", () => {
    vi.useFakeTimers();
    const setParam = vi.fn();
    const view = render(<TapeFilters state={baseState} setParam={setParam} />);
    const input = () => screen.getByLabelText("Search events by title or summary") as HTMLInputElement;

    view.rerender(<TapeFilters state={{ ...baseState, q: "usdt" }} setParam={setParam} />);
    expect(input().value).toBe("usdt");
    act(() => { vi.advanceTimersByTime(300); });
    expect(setParam).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: "usdc" } });
    act(() => { vi.advanceTimersByTime(250); });
    expect(setParam).toHaveBeenCalledWith("q", "usdc");
  });

  it("anchors sticky filters below the header and groups window and severity in segmented tracks", () => {
    const setParam = vi.fn();
    const { container } = render(<TapeFilters state={baseState} setParam={setParam} />);

    expect(container.firstElementChild?.className).toContain("top-[var(--sticky-header-bottom,3.75rem)]");
    const windowGroup = screen.getByRole("group", { name: "Filter by time window" });
    const severityGroup = screen.getByRole("group", { name: "Filter by severity floor" });
    expect(windowGroup.className).toContain("pharos-segmented");
    expect(severityGroup.className).toContain("pharos-segmented");
    expect(screen.getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Notice+" }).getAttribute("aria-pressed")).toBe("true");

    const classGroup = screen.getByRole("group", { name: "Filter by event type" });
    const allPill = classGroup.querySelector("button");
    expect(allPill?.textContent).toBe("All");
    expect(allPill?.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears selected event classes when the explicit All pill is clicked", () => {
    const setParam = vi.fn();
    render(<TapeFilters state={{ ...baseState, typeRaw: "depeg.*", type: ["depeg.*"] }} setParam={setParam} />);

    const classGroup = screen.getAllByRole("group", { name: "Filter by event type" })[0];
    const allPill = classGroup.querySelector("button")!;
    expect(allPill.textContent).toBe("All");
    expect(allPill.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(allPill);
    expect(setParam).toHaveBeenCalledWith("type", "");
  });
});
