// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNearViewport } from "@/hooks/use-near-viewport";

type IOEntryLike = { isIntersecting: boolean };
type IOCallback = (entries: IOEntryLike[]) => void;

interface IntersectionObserverMockInstance {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (entries: IOEntryLike[]) => void;
}

let lastObserverInstance: IntersectionObserverMockInstance | null = null;

function IntersectionObserverMock(callback: IOCallback): IntersectionObserverMockInstance {
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

const originalIO = window.IntersectionObserver;

beforeEach(() => {
  lastObserverInstance = null;
});

afterEach(() => {
  cleanup();
  // Restore IO to whatever jsdom started with (undefined by default).
  if (originalIO) {
    window.IntersectionObserver = originalIO;
  } else {
    Reflect.deleteProperty(window, "IntersectionObserver");
  }
});

describe("useNearViewport", () => {
  it("starts with near=false on the initial render when IntersectionObserver is available", () => {
    window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

    const { getByTestId } = render(<Probe />);

    // After the effect runs, the observer is wired up but no intersection has
    // fired yet — `near` must still be false.
    expect(getByTestId("probe").dataset.near).toBe("false");
    expect(lastObserverInstance?.observe).toHaveBeenCalledTimes(1);
  });

  it("flips near=true after the effect runs when IntersectionObserver is missing", () => {
    Reflect.deleteProperty(window, "IntersectionObserver");

    const { getByTestId } = render(<Probe />);

    // No IO available -> the effect short-circuits and sets near=true so the
    // consumer renders content rather than waiting forever.
    expect(getByTestId("probe").dataset.near).toBe("true");
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

  it("disconnects the observer when the hook unmounts before intersection", () => {
    window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

    const { unmount } = render(<Probe />);
    const instance = lastObserverInstance;
    expect(instance?.disconnect).not.toHaveBeenCalled();

    unmount();

    expect(instance?.disconnect).toHaveBeenCalled();
  });
});
