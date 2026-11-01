// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTimelineFeedInteractions } from "./use-timeline-feed-interactions";

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useTimelineFeedInteractions sentinel", () => {
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
