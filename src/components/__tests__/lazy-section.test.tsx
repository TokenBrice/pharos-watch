// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isLazyChartsEnabledMock } = vi.hoisted(() => ({
  isLazyChartsEnabledMock: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  isLazyChartsEnabled: isLazyChartsEnabledMock,
}));

import { LazySection } from "../lazy-section";

describe("LazySection", () => {
  beforeEach(() => {
    isLazyChartsEnabledMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders children immediately when the feature flag is off", () => {
    isLazyChartsEnabledMock.mockReturnValue(false);
    // Even with IO present, flag-off short-circuits.
    const { getByTestId, container } = render(
      <LazySection minHeight={200}>
        <div data-testid="child">payload</div>
      </LazySection>,
    );
    expect(getByTestId("child").textContent).toBe("payload");
    // No wrapper div with minHeight in the flag-off branch.
    expect(container.querySelector("[style*='min-height']")).toBeNull();
  });

  it("renders children eventually when the flag is on but IntersectionObserver is missing (jsdom default)", () => {
    isLazyChartsEnabledMock.mockReturnValue(true);
    // Ensure no IO is defined globally on this test path.
    // jsdom does not provide IntersectionObserver by default, but other tests
    // running in the same worker may have stubbed it; clear it here.
    vi.stubGlobal("IntersectionObserver", undefined);

    const { getByTestId } = render(
      <LazySection minHeight={200}>
        <div data-testid="child">payload</div>
      </LazySection>,
    );

    // The near-viewport hook flips synchronously in its mount effect when
    // IntersectionObserver is undefined, so children should be rendered.
    expect(getByTestId("child").textContent).toBe("payload");
  });

  it("renders the minHeight placeholder until 'near' flips when IntersectionObserver is available", () => {
    isLazyChartsEnabledMock.mockReturnValue(true);

    let triggerNear: (() => void) | null = null;
    class FakeIntersectionObserver {
      private callback: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.callback = cb;
        triggerNear = () => {
          this.callback(
            [{ isIntersecting: true } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        };
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);

    const { container, queryByTestId, getByTestId } = render(
      <LazySection minHeight={240}>
        <div data-testid="child">payload</div>
      </LazySection>,
    );

    // Before IO fires, child is hidden and the placeholder div carries minHeight.
    expect(queryByTestId("child")).toBeNull();
    const placeholder = container.firstChild as HTMLElement | null;
    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("style") ?? "").toMatch(/min-height:\s*240px/);

    act(() => {
      triggerNear?.();
    });

    // After IO fires, the child renders.
    expect(getByTestId("child").textContent).toBe("payload");
  });
});
