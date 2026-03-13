// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LongformScrollspyNav } from "@/components/longform-scrollspy-nav";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function Harness({ sections }: { sections: Array<{ id: string; label: string }> }) {
  return (
    <div>
      <LongformScrollspyNav sections={sections} navAriaLabel="Status sections" />
      <section id="overview">Overview</section>
      <section id="pipeline">Pipeline</section>
      <section id="reliability">Reliability</section>
    </div>
  );
}

describe("LongformScrollspyNav", () => {
  const scrollToMock = vi.fn();
  const getBoundingClientRectMock = vi.fn(function (this: HTMLElement) {
    if (this.id === "pipeline") {
      return {
        width: 100,
        height: 180,
        top: 360,
        right: 100,
        bottom: 540,
        left: 0,
        x: 0,
        y: 360,
        toJSON() {
          return {};
        },
      };
    }

    return {
      width: 100,
      height: 48,
      top: 0,
      right: 100,
      bottom: 48,
      left: 0,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: scrollToMock,
      writable: true,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 0,
      writable: true,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(getBoundingClientRectMock);
    window.history.replaceState(null, "", "#pipeline");
    scrollToMock.mockClear();
    getBoundingClientRectMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState(null, "", window.location.pathname);
  });

  it("aligns to the initial hash once without re-scrolling on later rerenders", () => {
    const { rerender } = render(
      <Harness
        sections={[
          { id: "overview", label: "Overview" },
          { id: "pipeline", label: "Pipeline" },
          { id: "reliability", label: "Reliability" },
        ]}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(scrollToMock).toHaveBeenCalledTimes(4);

    rerender(
      <Harness
        sections={[
          { id: "pipeline", label: "Pipeline" },
          { id: "overview", label: "Overview" },
          { id: "reliability", label: "Reliability" },
        ]}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(scrollToMock).toHaveBeenCalledTimes(4);
  });

  it("does not start hash-alignment on a later refresh when the page loaded without one", () => {
    window.history.replaceState(null, "", window.location.pathname);

    const { rerender } = render(
      <Harness
        sections={[
          { id: "overview", label: "Overview" },
          { id: "pipeline", label: "Pipeline" },
          { id: "reliability", label: "Reliability" },
        ]}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(scrollToMock).not.toHaveBeenCalled();

    window.history.replaceState(null, "", "#pipeline");
    rerender(
      <Harness
        sections={[
          { id: "pipeline", label: "Pipeline" },
          { id: "overview", label: "Overview" },
          { id: "reliability", label: "Reliability" },
        ]}
      />,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(scrollToMock).not.toHaveBeenCalled();
  });
});
