import { cleanup } from "@testing-library/react";
import { vi } from "vitest";

type MatchMediaMock = ReturnType<typeof vi.fn>;

function createMatchMediaMock(matches = false): MatchMediaMock {
  return vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

export function installMatchMediaMock(matches = false): MatchMediaMock {
  const mock = createMatchMediaMock(matches);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: mock,
  });
  return mock;
}

export function resetBrowserStorage(): void {
  window.localStorage.clear();
  window.sessionStorage.clear();
}

export function cleanupFrontendTest(): void {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}

export async function createNextLinkMock() {
  const React = await import("react");
  return {
    default: React.forwardRef<HTMLAnchorElement, { href: string; children: React.ReactNode }>(
      function MockLink({ href, children, ...rest }, ref) {
        return React.createElement("a", { ref, href, ...rest }, children);
      },
    ),
  };
}
