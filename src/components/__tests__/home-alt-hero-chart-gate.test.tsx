// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAltHeroChartGate } from "@/components/home-alt-hero-chart-gate";

const readiness = vi.hoisted(() => ({ hydrated: false, near: false }));
vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => readiness.hydrated }));
vi.mock("@/hooks/use-near-viewport", () => ({
  useNearViewport: () => ({ ref: () => {}, near: readiness.near }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="live-chart" /> }));
vi.mock("@/components/home-alt-hero-chart-fallback", () => ({
  HomeAltHeroChartFallback: () => <div data-testid="chart-fallback" />,
}));

beforeEach(() => {
  readiness.hydrated = false;
  readiness.near = false;
  vi.useFakeTimers();
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("HomeAltHeroChartGate", () => {
  it("activates within 250ms only after hydration and viewport readiness without rIC", () => {
    const { rerender } = render(<HomeAltHeroChartGate />);
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByTestId("live-chart")).toBeNull();
    readiness.hydrated = true;
    rerender(<HomeAltHeroChartGate />);
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByTestId("live-chart")).toBeNull();

    readiness.near = true;
    rerender(<HomeAltHeroChartGate />);
    act(() => vi.advanceTimersByTime(181));
    expect(screen.getByTestId("chart-fallback")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTestId("live-chart")).toBeTruthy();
  });

  it("cancels pending activation if the visible gate is no longer ready", () => {
    readiness.hydrated = true;
    readiness.near = true;
    const { rerender } = render(<HomeAltHeroChartGate />);
    act(() => vi.advanceTimersByTime(40));
    readiness.near = false;
    rerender(<HomeAltHeroChartGate />);
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.queryByTestId("live-chart")).toBeNull();
  });
});
