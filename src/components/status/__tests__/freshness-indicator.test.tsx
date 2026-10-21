// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { FreshnessIndicator } from "../freshness-indicator";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    act(() => {
      timestamp.focus();
      vi.advanceTimersByTime(220);
    });
    expect(screen.getByRole("tooltip").textContent).toContain("more than 12m old");
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

  it("gives compact chips the public stale band and noncompact chips the exact budget", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const updatedAtMs = 1_700_000_000_000 - 90_000;
    const { rerender } = render(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    expect(screen.getByRole("time").getAttribute("datetime")).toBe("2023-11-14T22:11:50.000Z");
    expect(screen.getByRole("time").getAttribute("data-stale-after-ms")).toBe("720000");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toContain("more than 12m old");

    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
    expect(screen.getByRole("time").getAttribute("datetime")).toBe("2023-11-14T22:11:50.000Z");
    expect(screen.getByRole("time").getAttribute("data-stale-after-ms")).toBe("60000");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toContain("more than 1m old");

    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs - 700_000} staleAfterMs={60_000} compact />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("true");
  });

  it("discloses the already doubled redemption budget without multiplying it again", () => {
    vi.setSystemTime(new Date(1_700_000_000_000));
    const updatedAtMs = 1_700_000_000_000 - 57_600_000;
    const staleAfterMs = API_FRESHNESS_MAX_AGE_SEC.redemptionBackstops * 2000;
    const { rerender } = render(<FreshnessIndicator updatedAtMs={updatedAtMs} staleAfterMs={staleAfterMs} />);
    expect(screen.getByRole("time").getAttribute("datetime")).toBe("2023-11-14T06:13:20.000Z");
    expect(screen.getByRole("time").getAttribute("data-stale-after-ms")).toBe("57600000");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toContain("more than 16h old");
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("current");
    rerender(<FreshnessIndicator updatedAtMs={updatedAtMs - 1} staleAfterMs={staleAfterMs} />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("stale");
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
    // A first load is not a recovery: nothing is announced.
    expect(screen.getByRole("status").textContent).toBe("");
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
