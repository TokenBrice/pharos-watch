// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNearViewport } from "@/hooks/use-near-viewport";

type IOEntry = { isIntersecting: boolean };

interface IntersectionObserverMockInstance {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (entries: IOEntry[]) => void;
}

let lastObserverInstance: IntersectionObserverMockInstance | null = null;

function IntersectionObserverMock(callback: (entries: IOEntry[]) => void): IntersectionObserverMockInstance {
  const instance: IntersectionObserverMockInstance = {
    observe: vi.fn(),
    disconnect: vi.fn(),
    trigger: (entries) => callback(entries),
  };
  lastObserverInstance = instance;
  return instance;
}

function Probe({ rootMargin }: { rootMargin?: string }) {
  const { ref, near } = useNearViewport<HTMLDivElement>(rootMargin);
  return <div ref={ref} data-testid="probe" data-near={String(near)} />;
}

function DelayedProbe({ show }: { show: boolean }) {
  const { ref, near } = useNearViewport<HTMLDivElement>();
  return show ? <div ref={ref} data-testid="probe" data-near={String(near)} /> : <span data-testid="loading" />;
}

const originalIO = window.IntersectionObserver;

beforeEach(() => {
  lastObserverInstance = null;
});

afterEach(() => {
  cleanup();
  if (originalIO) {
    window.IntersectionObserver = originalIO;
  } else {
    Reflect.deleteProperty(window, "IntersectionObserver");
  }
});

describe("useNearViewport", () => {
  it("observes an element that is attached after the initial hook effect", () => {
    window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

    const { getByTestId, rerender } = render(<DelayedProbe show={false} />);

    expect(getByTestId("loading")).toBeTruthy();

    rerender(<DelayedProbe show />);

    const probe = getByTestId("probe");
    expect(probe.dataset.near).toBe("false");
    act(() => lastObserverInstance?.trigger([{
      isIntersecting: lastObserverInstance.observe.mock.calls.some(([el]) => el === probe),
    }]));
    expect(probe.dataset.near).toBe("true");
  });

  it("flips near=true and disconnects the observer when the element intersects", () => {
    window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

    const { getByTestId } = render(<Probe />);
    expect(getByTestId("probe").dataset.near).toBe("false");

    const instance = lastObserverInstance;
    expect(instance).not.toBeNull();

    act(() => {
      instance?.trigger([{ isIntersecting: true }]);
    });

    expect(getByTestId("probe").dataset.near).toBe("true");
    expect(instance?.disconnect).toHaveBeenCalled();
  });
});
