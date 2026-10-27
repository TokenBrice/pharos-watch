// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { deriveDataHealth } from "@/lib/data-health";
import { DATA_HEALTH_PRESETS } from "@/lib/data-health-config";
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

  it("gives a supplied public verdict the redemption 4d band instead of a local 16h threshold", () => {
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(new Date(nowMs));
    const updatedAtMs = nowMs - 96 * 3_600_000;
    const health = (atMs: number) => deriveDataHealth({ ...DATA_HEALTH_PRESETS.redemptionBackstops, dataUpdatedAt: updatedAtMs, hasData: true }, atMs);
    const sixteenHours = deriveDataHealth({ ...DATA_HEALTH_PRESETS.redemptionBackstops, dataUpdatedAt: nowMs - 16 * 3_600_000, hasData: true }, nowMs);
    const { rerender } = render(<FreshnessIndicator updatedAtMs={0} staleAfterMs={1} health={sixteenHours} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("current");

    rerender(<FreshnessIndicator updatedAtMs={0} staleAfterMs={1} health={health(nowMs)} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("retained");
    expect(screen.getByRole("time").getAttribute("datetime")).toBe(new Date(updatedAtMs).toISOString());
    expect(screen.getByRole("time").getAttribute("data-stale-after-ms")).toBe("345600000");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toMatch(/^Updated at .+\. Stale when more than 4d old$/);
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(<FreshnessIndicator updatedAtMs={0} staleAfterMs={1} health={health(nowMs + 1)} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("stale");
    expect(screen.getByRole("status").textContent).toBe("Updated is stale.");

    const recovered = deriveDataHealth({ ...DATA_HEALTH_PRESETS.redemptionBackstops, dataUpdatedAt: nowMs, hasData: true }, nowMs);
    rerender(<FreshnessIndicator updatedAtMs={0} staleAfterMs={1} health={recovered} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("current");
    expect(screen.getByRole("status").textContent).toBe("Updated is current again.");
  });

  it("never lets the internal age timer override a supplied verdict", () => {
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(new Date(nowMs));
    const health = deriveDataHealth({ ...DATA_HEALTH_PRESETS.redemptionBackstops, dataUpdatedAt: nowMs - 3_600_000, hasData: true }, nowMs);
    render(<FreshnessIndicator updatedAtMs={nowMs - 3_600_000} staleAfterMs={1_000} health={health} />);
    act(() => {
      vi.advanceTimersByTime(2 * 3_600_000);
    });
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("uses the producer budget, keeps retained failures neutral and explicit null authority unknown", () => {
    const nowMs = 1_700_000_000_000;
    vi.setSystemTime(new Date(nowMs));
    const base = { ...DATA_HEALTH_PRESETS.redemptionBackstops, dataUpdatedAt: nowMs, hasData: true };
    const budgeted = deriveDataHealth({
      ...base,
      meta: { updatedAt: (nowMs - 5 * 86_400_000) / 1000, ageSeconds: 432_000, status: "degraded", freshBudgetSec: 86_400, degradedBudgetSec: 6 * 86_400 },
    }, nowMs);
    const { rerender } = render(<FreshnessIndicator updatedAtMs={nowMs} staleAfterMs={1} health={budgeted} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("retained");
    expect(screen.getByRole("time").querySelector(".sr-only")?.textContent).toContain("more than 6d old");

    const floor = deriveDataHealth({ ...base, meta: { updatedAt: nowMs / 1000, ageSeconds: 0, status: "stale" } }, nowMs);
    rerender(<FreshnessIndicator updatedAtMs={nowMs} staleAfterMs={1} health={floor} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("stale");

    const retainedFailure = deriveDataHealth({ ...base, error: new Error("refetch failed") }, nowMs);
    rerender(<FreshnessIndicator updatedAtMs={nowMs} staleAfterMs={1} health={retainedFailure} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("retained");
    expect(screen.getByRole("time").getAttribute("data-stale")).toBe("false");

    const unknown = deriveDataHealth({ ...base, meta: { updatedAt: null, ageSeconds: null, status: "unknown" } }, nowMs);
    rerender(<FreshnessIndicator updatedAtMs={nowMs} staleAfterMs={1} health={unknown} labelPrefix="Updated" />);
    expect(screen.getByRole("time").getAttribute("data-state")).toBe("unavailable");
    expect(screen.getByRole("time").getAttribute("datetime")).toBeNull();
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
