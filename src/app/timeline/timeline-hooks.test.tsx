// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupFrontendTest, resetBrowserStorage } from "@/test-utils/frontend";
import { useTimelineFeedInteractions } from "./use-timeline-feed-interactions";
import { useTimelinePhosphor } from "./use-timeline-phosphor";

const { themeState } = vi.hoisted(() => ({ themeState: { theme: "system", resolvedTheme: "dark" as string | undefined } }));
vi.mock("next-themes", () => ({ useTheme: () => ({ ...themeState, setTheme: vi.fn() }) }));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));

describe("useTimelineFeedInteractions", () => {
  const observers: Array<{ cb: IntersectionObserverCallback; target: Element | null }> = [];

  class FakeIntersectionObserver {
    private entry: { cb: IntersectionObserverCallback; target: Element | null };
    constructor(cb: IntersectionObserverCallback) {
      this.entry = { cb, target: null };
      observers.push(this.entry);
    }
    observe(target: Element) { this.entry.target = target; }
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = "";
    thresholds = [];
  }

  function cross(isIntersecting = true) {
    const last = observers[observers.length - 1]!;
    act(() => {
      last.cb(
        [{ isIntersecting, boundingClientRect: { bottom: 500, top: 400 } } as IntersectionObserverEntry],
        last as unknown as IntersectionObserver,
      );
    });
  }

  function Harness(props: {
    fetchNextPage: () => Promise<unknown>;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    nextPageError: boolean;
  }) {
    const { sentinelRef, handleLoadMore } = useTimelineFeedInteractions({
      filterSignature: "sig",
      permalinkId: "",
      permalinkResolved: false,
      loadedCount: 500,
      total: null,
      ...props,
    });
    return (
      <div>
        <button type="button" onClick={handleLoadMore}>Load more</button>
        <div ref={sentinelRef} data-testid="sentinel" />
      </div>
    );
  }

  afterEach(() => {
    observers.length = 0;
    cleanupFrontendTest();
    vi.clearAllMocks();
  });

  it.each([
    ["", false],
    ["missing", false],
    ["linked", false],
    ["replacement", true],
  ] as const)("clears the previous highlight when target becomes '%s' (resolved=%s)", (permalinkId, permalinkResolved) => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook((target) => useTimelineFeedInteractions({
      filterSignature: "sig", loadedCount: 1, total: 1,
      fetchNextPage: vi.fn(), hasNextPage: false, isFetchingNextPage: false, nextPageError: false,
      ...target,
    }), { initialProps: { permalinkId: "linked", permalinkResolved: true } });
    act(() => vi.advanceTimersByTime(20));
    expect(result.current.highlightedId).toBe("linked");
    act(() => vi.advanceTimersByTime(1_000));

    rerender({ permalinkId, permalinkResolved });
    expect(result.current.highlightedId).toBeNull();
    act(() => vi.advanceTimersByTime(20));
    expect(result.current.highlightedId).toBe(permalinkResolved ? permalinkId : null);
    act(() => vi.advanceTimersByTime(2_000));
    expect(result.current.highlightedId).toBeNull();
  });

  it("stops auto-loading after a failed next-page fetch until the reader retries", () => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const fetchNextPage = vi.fn().mockResolvedValue(undefined);
    const props = { fetchNextPage, hasNextPage: true, isFetchingNextPage: false, nextPageError: false };
    const { rerender } = render(<Harness {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // A page request is in flight, then rejects: TanStack returns
    // isFetchingNextPage to false and reports a next-page error.
    rerender(<Harness {...props} isFetchingNextPage />);
    rerender(<Harness {...props} nextPageError />);

    cross();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    // The reader's own Load more is still the retry path.
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});

describe("useTimelinePhosphor", () => {
  const STORAGE_KEY = "pharos:timeline-phosphor";

  beforeEach(() => {
    resetBrowserStorage();
    themeState.resolvedTheme = "dark";
    window.localStorage.setItem(STORAGE_KEY, "1");
  });
  afterEach(() => {
    cleanupFrontendTest();
    resetBrowserStorage();
  });

  it("does not clear the preference before the rendered theme resolves", () => {
    themeState.resolvedTheme = undefined;
    const { result, rerender } = renderHook(() => useTimelinePhosphor());
    expect(result.current.phosphorToggleVisible).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
    themeState.resolvedTheme = "dark";
    rerender();
    expect(result.current.phosphorActive).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("clears phosphor only when the rendered system theme becomes light", () => {
    const { result, rerender } = renderHook(() => useTimelinePhosphor());
    themeState.resolvedTheme = "light";
    rerender();
    expect(result.current.phosphorActive).toBe(false);
    expect(result.current.phosphorToggleVisible).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    themeState.resolvedTheme = "dark";
    rerender();
    expect(result.current.phosphorActive).toBe(false);
    expect(result.current.phosphorToggleVisible).toBe(true);
  });
});
