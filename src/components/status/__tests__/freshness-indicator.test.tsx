// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { FreshnessIndicator } from "../freshness-indicator";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Restore jsdom's prototype getter if a test overrode document.visibilityState.
  Reflect.deleteProperty(document, "visibilityState");
});

describe("FreshnessIndicator", () => {
  it("makes exact timestamp help keyboard focusable", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000} staleAfterMs={60_000} compact />);

    const timestamp = screen.getByRole("time");
    expect(timestamp.getAttribute("tabindex")).toBe("0");
    expect(timestamp.className).toContain("min-h-6");
  });

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
    const absoluteLabel = screen.getByRole("time").querySelector(".sr-only")?.textContent;

    expect(absoluteLabel).toMatch(/^Refreshed at /);
    expect(screen.getByRole("status").textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText(/35s ago/i)).toBeDefined();
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toBe(absoluteLabel);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("announces only freshness-state transitions, never age ticks", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(
      <FreshnessIndicator
        updatedAtMs={1_700_000_000_000 - 100_000}
        staleAfterMs={120_000}
        labelPrefix="Dashboard fetch"
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Dashboard fetch is stale.");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole("status").textContent).toBe("Dashboard fetch is stale.");
  });

  it("renders a missing timestamp as unavailable rather than extremely old", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={0} staleAfterMs={120_000} labelPrefix="Dashboard fetch" />);

    expect(screen.getByText("Dashboard fetch: not loaded")).toBeDefined();
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toBe("Dashboard fetch has not loaded");
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
  it("gives compact chips a doubled staleness budget and noncompact chips the exact one", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const updatedAtMs = 1_700_000_000_000 - 90_000;
    const { rerender } = render(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");

    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");

    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs - 45_000} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
  });

  it("announces recovery when stale data is replaced by a fresh timestamp", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { rerender } = render(
      <FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={120_000} />,
    );
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(<FreshnessIndicator updatedAtMs={1_700_000_000_000} staleAfterMs={120_000} />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("Data is current again.");
  });

  it("recovers to a live reading once an unavailable feed loads", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const { rerender } = render(<FreshnessIndicator updatedAtMs={0} staleAfterMs={120_000} />);
    expect(screen.getByText("not loaded")).toBeTruthy();
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("unavailable");

    rerender(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 30_000} staleAfterMs={120_000} />);
    expect(screen.getByText("30s ago")).toBeTruthy();
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("current");
    expect(screen.getByRole("status").textContent).toBe("Data is current again.");
  });

  it("pauses ticking while the document is hidden and catches up on visibility", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    render(<FreshnessIndicator updatedAtMs={1_700_000_000_000 - 180_000} staleAfterMs={600_000} />);
    expect(screen.getByText("3m ago")).toBeTruthy();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(screen.getByText("3m ago")).toBeTruthy();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("13m ago")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("14m ago")).toBeTruthy();
  });
});
