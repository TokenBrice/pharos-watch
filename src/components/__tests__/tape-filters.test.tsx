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
});
