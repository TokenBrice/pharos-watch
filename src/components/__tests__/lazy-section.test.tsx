// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LazySection } from "../lazy-section";

describe("LazySection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders children eventually when IntersectionObserver is missing (jsdom default)", () => {
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
