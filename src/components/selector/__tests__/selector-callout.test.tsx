// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SelectorCallout } from "@/components/selector/selector-callout";
import {
  cleanupFrontendTest,
  installMatchMediaMock,
  resetBrowserStorage,
} from "@/test-utils/frontend";

const CALLOUT_KEY = "pharos.selector.callout.v1";
const LEGACY_CALLOUT_KEY = "pharos-selector-callout-v1";

beforeEach(() => {
  resetBrowserStorage();
  installMatchMediaMock(false);
});

afterEach(() => {
  cleanupFrontendTest();
});

describe("SelectorCallout", () => {
  it("renders default desktop variant with primary CTA", () => {
    render(<SelectorCallout />);
    expect(screen.getByText(/Pharos Stablecoin Picker/i)).toBeTruthy();
    const cta = screen.getByRole("link", { name: /Try the Picker/i });
    expect(cta.getAttribute("href")).toMatch(/^\/screener\/picker\/?$/);
  });

  it("renders dismissed variant when storage marks dismissed", () => {
    window.localStorage.setItem(CALLOUT_KEY, "dismissed");
    render(<SelectorCallout />);
    expect(screen.getByText(/Picker hidden/i)).toBeTruthy();
    const restore = screen.getByText(/Bring back the Picker/i);
    fireEvent.click(restore);
    expect(screen.queryByText(/Picker hidden/i)).toBeNull();
    expect(window.localStorage.getItem(CALLOUT_KEY)).toBe("default");
  });

  it("respects the legacy hyphenated dismissal key", () => {
    window.localStorage.setItem(LEGACY_CALLOUT_KEY, "dismissed");
    render(<SelectorCallout />);
    expect(screen.getByText(/Picker hidden/i)).toBeTruthy();
  });

  it("dismissing the default desktop card persists dismissed state", () => {
    render(<SelectorCallout />);
    const dismiss = screen.getByRole("button", { name: /Dismiss Picker callout/i });
    fireEvent.click(dismiss);
    expect(window.localStorage.getItem(CALLOUT_KEY)).toBe("dismissed");
    expect(screen.getByText(/Picker hidden/i)).toBeTruthy();
  });

  it("ignores legacy `has-run` value (feature removed); renders default", () => {
    window.localStorage.setItem(CALLOUT_KEY, "has-run");
    render(<SelectorCallout />);
    expect(screen.getByText(/Pharos Stablecoin Picker/i)).toBeTruthy();
  });
});
