// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartBrush, type BrushedRange } from "./sync";

// jsdom lacks ResizeObserver; ChartBrush wires one up on mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const DAY = 86_400_000;
// Fixed UTC domain: 2024-01-01 .. 2024-01-11 (span = 10 days).
const DOMAIN: readonly [number, number] = [Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 11)];
const SPAN = DOMAIN[1] - DOMAIN[0];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChartBrush keyboard + ARIA contract", () => {
  it("exposes a focusable slider with valuetext describing the window", () => {
    render(<ChartBrush domain={DOMAIN} value={[DOMAIN[0] + 2 * DAY, DOMAIN[0] + 5 * DAY]} onChange={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Brush time window" });
    expect(slider.getAttribute("tabindex")).toBe("0");
    expect(slider.getAttribute("aria-valuemin")).toBe(String(DOMAIN[0]));
    expect(slider.getAttribute("aria-valuemax")).toBe(String(DOMAIN[1]));
    expect(slider.getAttribute("aria-valuetext")).toMatch(/to/);
  });

  it("describes the full range in valuetext when no window is set", () => {
    render(<ChartBrush domain={DOMAIN} value={null} onChange={() => {}} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toMatch(/^Full range:/);
  });

  it("ArrowRight shifts an existing window forward by 5% of the span", () => {
    const onChange = vi.fn();
    const value: BrushedRange = [DOMAIN[0] + 2 * DAY, DOMAIN[0] + 5 * DAY];
    render(<ChartBrush domain={DOMAIN} value={value} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as [number, number];
    expect(next[0]).toBeCloseTo(value[0] + SPAN * 0.05, 5);
    expect(next[1]).toBeCloseTo(value[1] + SPAN * 0.05, 5);
  });

  it("ArrowLeft clamps the window at the domain floor preserving width", () => {
    const onChange = vi.fn();
    // Window already pinned to the floor: any leftward shift must clamp.
    const value: BrushedRange = [DOMAIN[0], DOMAIN[0] + 3 * DAY];
    render(<ChartBrush domain={DOMAIN} value={value} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft" });
    const next = onChange.mock.calls[0][0] as [number, number];
    expect(next[0]).toBe(DOMAIN[0]);
    expect(next[1] - next[0]).toBe(value[1] - value[0]);
  });

  it("ArrowRight seeds a centered window when none exists", () => {
    const onChange = vi.fn();
    render(<ChartBrush domain={DOMAIN} value={null} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as [number, number];
    expect(next[0]).toBeGreaterThan(DOMAIN[0]);
    expect(next[1]).toBeLessThan(DOMAIN[1]);
    expect(next[0]).toBeLessThan(next[1]);
  });

  it("Home and End clear the brush back to the full domain", () => {
    const onChange = vi.fn();
    render(<ChartBrush domain={DOMAIN} value={[DOMAIN[0] + 2 * DAY, DOMAIN[0] + 5 * DAY]} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("slider"), { key: "Home" });
    fireEvent.keyDown(screen.getByRole("slider"), { key: "End" });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[0][0]).toBeNull();
    expect(onChange.mock.calls[1][0]).toBeNull();
  });
});
