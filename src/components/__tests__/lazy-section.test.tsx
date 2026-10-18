// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LazySection } from "../lazy-section";
import { revealDeferredSectionsThroughAnchor } from "@/lib/anchor-reveal";

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

  it("holds the reserve after mount until the section has been seen and scrolled off screen", () => {
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
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    const fire = (index: number, isIntersecting: boolean, bottom = 500) => act(() => {
      observers[index]!.cb(
        [{ isIntersecting, boundingClientRect: { bottom, top: bottom - 100 } } as IntersectionObserverEntry],
        observers[index] as unknown as IntersectionObserver,
      );
    });

    const { container, getByTestId } = render(
      <LazySection minHeight={300}>
        <div data-testid="child">short</div>
      </LazySection>,
    );
    const wrapper = container.firstChild as HTMLElement;
    fire(0, true); // near: mount children
    expect(getByTestId("child")).toBeTruthy();
    // The loading child is shorter than the reserve; the reserve holds while on screen.
    expect(wrapper.getAttribute("style") ?? "").toMatch(/min-height:\s*300px/);
    fire(1, false); // not yet seen: keep
    expect(wrapper.getAttribute("style") ?? "").toMatch(/min-height:\s*300px/);
    fire(1, true); // seen
    fire(1, false, 1200); // exits below the viewport: release
    expect(wrapper.style.minHeight).toBe("");
  });

  it("keeps no-hash geometry unchanged and reveals only islands through the initial hash zone", () => {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    const { container, queryByText } = render(
      <main>
        <h2 id="market">Market</h2>
        <LazySection minHeight={320}><p>Market payload</p></LazySection>
        <h2 id="history">History</h2>
        <LazySection minHeight={390}><p>History payload</p></LazySection>
        <h2 id="explore">Explore</h2>
        <LazySection minHeight={600}><p>Explore payload</p></LazySection>
      </main>,
    );
    expect(queryByText("Market payload")).toBeNull();
    expect(queryByText("History payload")).toBeNull();
    const reserves = [...container.querySelectorAll<HTMLElement>("[data-lazy-section]")];
    expect(reserves.map((node) => node.style.minHeight)).toEqual(["320px", "390px", "600px"]);
    act(() => {
      revealDeferredSectionsThroughAnchor("history", ["market", "history", "explore"], container);
    });
    expect(queryByText("Market payload")).not.toBeNull();
    expect(queryByText("History payload")).not.toBeNull();
    expect(queryByText("Explore payload")).toBeNull();
    expect(reserves.map((node) => node.style.minHeight)).toEqual(["320px", "390px", "600px"]);
  });

  it("force-mounts an anchor target without dropping the reserve or waiting for intersection", () => {
    const callbacks: IntersectionObserverCallback[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        if (!options) callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    const { container, getByTestId } = render(
      <LazySection minHeight={300} forceMount>
        <div data-testid="child">target</div>
      </LazySection>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(getByTestId("child").textContent).toBe("target");
    expect(wrapper.style.minHeight).toBe("300px");
    // The reserve observer uses real visibility, not the proximity rootMargin.
    const fire = (isIntersecting: boolean) => act(() => callbacks[0]!([
      { isIntersecting, boundingClientRect: { bottom: 1_200 } } as IntersectionObserverEntry,
    ], {} as IntersectionObserver));
    fire(false);
    expect(wrapper.style.minHeight).toBe("300px");
    fire(true);
    fire(false);
    expect(wrapper.style.minHeight).toBe("");
  });
});
