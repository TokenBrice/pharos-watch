import { describe, it, expect, vi } from "vitest";
import { observeReducedMotion } from "./reduced-motion";

describe("observeReducedMotion", () => {
  it("invokes callback with current value, then on change", () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    let matches = false;
    const fakeMq = {
      get matches() { return matches; },
      addEventListener: (_: "change", cb: (e: { matches: boolean }) => void) => listeners.push(cb),
      removeEventListener: vi.fn(),
    };
    const matchMedia = vi.fn().mockReturnValue(fakeMq);

    const cb = vi.fn();
    const dispose = observeReducedMotion(cb, matchMedia as unknown as typeof window.matchMedia);

    expect(cb).toHaveBeenCalledWith(false);

    matches = true;
    listeners.forEach((l) => l({ matches: true }));
    expect(cb).toHaveBeenCalledWith(true);

    dispose();
    expect(fakeMq.removeEventListener).toHaveBeenCalled();
  });
});
