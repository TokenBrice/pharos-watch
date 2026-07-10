// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { FreshnessIndicator } from "../freshness-indicator";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("FreshnessIndicator", () => {
  it("renders 'just now' when updatedAt is within 5s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 2000} staleAfterMs={120_000} />);
    expect(screen.getByText(/just now/i)).toBeDefined();
  });

  it("renders 'Xs ago' between 5s and 60s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 42_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/42s ago/i)).toBeDefined();
  });

  it("renders 'Xm ago' above 60s", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/3m ago/i)).toBeDefined();
  });

  it("marks stale when age exceeds staleAfterMs", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={120_000} />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
  });

  it("does NOT mark stale when within window", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 30_000} staleAfterMs={120_000} />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
  });

  it("increments age via internal timer", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 30_000} staleAfterMs={120_000} />);
    expect(screen.getByText(/30s ago/i)).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/35s ago/i)).toBeDefined();
  });

  it("uses minute-boundary timeouts instead of a permanent one-second interval for older data", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={600_000} />);

    expect(screen.getByText(/3m ago/i)).toBeDefined();
    expect(intervalSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(screen.getByText(/3m ago/i)).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(/4m ago/i)).toBeDefined();
  });

  it("keeps ticking age text out of live regions", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 30_000} staleAfterMs={120_000} />);
    const absoluteLabel = screen.getByRole("time").getAttribute("aria-label");

    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/35s ago/i)).toBeDefined();
    expect(screen.getByRole("time").getAttribute("aria-label")).toBe(absoluteLabel);
  });

  it("renders a missing timestamp as unavailable rather than extremely old", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={0} staleAfterMs={120_000} labelPrefix="Dashboard fetch" />);

    expect(screen.getByText("Dashboard fetch: not loaded")).toBeDefined();
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByRole("time").getAttribute("aria-label")).toBe("Dashboard fetch has not loaded");
  });

  it("can label browser/dashboard fetch freshness explicitly", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(
      <FreshnessIndicator
        updatedAtMs={1_700_000_000_000 - 30_000}
        staleAfterMs={120_000}
        labelPrefix="Dashboard fetch"
      />,
    );
    expect(screen.getByText(/Dashboard fetch: 30s ago/i)).toBeDefined();
  });
});
