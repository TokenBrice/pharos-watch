// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SelectorCallout } from "@/components/selector/selector-callout";

const CALLOUT_KEY = "pharos.selector.callout.v1";
const LEGACY_CALLOUT_KEY = "pharos-selector-callout-v1";

beforeEach(() => {
  // jsdom: each test starts with a clean localStorage and viewport.
  window.localStorage.clear();
  // Default matchMedia: desktop unless overridden.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
});

describe("SelectorCallout", () => {
  it("renders default desktop variant with primary CTA", () => {
    render(<SelectorCallout />);
    expect(screen.getByText(/Pharos Stablecoin Selector/i)).toBeTruthy();
    const cta = screen.getByRole("link", { name: /Try the Selector/i });
    expect(cta.getAttribute("href")).toMatch(/^\/screener\/selector\/?$/);
  });

  it("renders dismissed variant when storage marks dismissed", () => {
    window.localStorage.setItem(CALLOUT_KEY, "dismissed");
    render(<SelectorCallout />);
    expect(screen.getByText(/Selector hidden/i)).toBeTruthy();
    const restore = screen.getByText(/Bring back the Selector/i);
    fireEvent.click(restore);
    expect(screen.queryByText(/Selector hidden/i)).toBeNull();
    expect(window.localStorage.getItem(CALLOUT_KEY)).toBe("default");
  });

  it("respects the legacy hyphenated dismissal key", () => {
    window.localStorage.setItem(LEGACY_CALLOUT_KEY, "dismissed");
    render(<SelectorCallout />);
    expect(screen.getByText(/Selector hidden/i)).toBeTruthy();
  });

  it("dismissing the default desktop card persists dismissed state", () => {
    render(<SelectorCallout />);
    const dismiss = screen.getByRole("button", { name: /Dismiss Selector callout/i });
    fireEvent.click(dismiss);
    expect(window.localStorage.getItem(CALLOUT_KEY)).toBe("dismissed");
    expect(screen.getByText(/Selector hidden/i)).toBeTruthy();
  });

  it("ignores legacy `has-run` value (feature removed); renders default", () => {
    window.localStorage.setItem(CALLOUT_KEY, "has-run");
    render(<SelectorCallout />);
    expect(screen.getByText(/Pharos Stablecoin Selector/i)).toBeTruthy();
  });
});
