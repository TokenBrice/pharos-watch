// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SafetyMapPoster } from "./poster";

/**
 * These tests drive the component through the three states a real browser can
 * hand it, by stubbing what the `<img>` element reports about its own fetch.
 *
 * jsdom never loads `src`, and it reports `complete === false` for an image
 * that has one, so it does **not** reproduce the pre-hydration failure on its
 * own — both properties have to be stubbed. That makes the first case below a
 * simulation of the browser's reported state, not of the event ordering that
 * causes it; the ordering itself is only observable in a real page load. It is
 * still a true regression test: an `onError`-only component receives no event
 * in any of these renders, so it would leave the broken image and the dead
 * download link on screen and the first two cases would fail.
 *
 * Both are read-only getters on the prototype, hence `defineProperty`.
 */
function withImageState(state: { complete: boolean; naturalWidth: number }, run: () => void): void {
  const originals = (["complete", "naturalWidth"] as const).map((property) => ({
    property,
    descriptor: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, property),
  }));

  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get: () => state.complete,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => state.naturalWidth,
  });

  try {
    run();
  } finally {
    for (const { property, descriptor } of originals) {
      if (descriptor) {
        Object.defineProperty(HTMLImageElement.prototype, property, descriptor);
      } else {
        delete (HTMLImageElement.prototype as unknown as Record<string, unknown>)[property];
      }
    }
  }
}

/** The poster 404'd before React hydrated: the fetch is finished and produced nothing. */
const FAILED_BEFORE_HYDRATION = { complete: true, naturalWidth: 0 };
/** The poster loaded normally. */
const LOADED = { complete: true, naturalWidth: 3200 };
/** Still in flight at mount, so the ref callback must defer to `onError`. */
const STILL_LOADING = { complete: false, naturalWidth: 0 };

function poster(): HTMLElement | null {
  return screen.queryByRole("img", { name: /Pharos Stablecoin Safety Map/i });
}

function downloadLink(): HTMLElement | null {
  return screen.queryByRole("link", { name: /Download the poster/i });
}

function fallbackText(): HTMLElement | null {
  return screen.queryByText(/The map is not available right now/i);
}

describe("SafetyMapPoster", () => {
  afterEach(cleanup);

  it("shows the explanatory panel when the poster already failed before hydration", () => {
    withImageState(FAILED_BEFORE_HYDRATION, () => {
      render(<SafetyMapPoster />);

      expect(fallbackText()).not.toBeNull();
      expect(poster()).toBeNull();
      expect(downloadLink()).toBeNull();
    });
  });

  it("points at the live data when the poster is unavailable", () => {
    withImageState(FAILED_BEFORE_HYDRATION, () => {
      render(<SafetyMapPoster />);

      // Slash-tolerant: `next/link` only appends the canonical trailing slash
      // when `trailingSlash: true` from next.config is in play, which it is not
      // under vitest. The built output is what `seo:check` holds to that rule.
      expect(screen.getByRole("link", { name: /Safety Scores page/i }).getAttribute("href")).toMatch(
        /^\/safety-scores\/?$/,
      );
    });
  });

  it("renders the poster and the download affordance when the image loads", () => {
    withImageState(LOADED, () => {
      render(<SafetyMapPoster />);

      expect(poster()).not.toBeNull();
      expect(downloadLink()?.getAttribute("href")).toBe("/safety-scores/map.png");
      expect(fallbackText()).toBeNull();
    });
  });

  it("leaves a still-loading image alone at mount, then falls back if it errors", () => {
    withImageState(STILL_LOADING, () => {
      render(<SafetyMapPoster />);
      const image = poster();
      expect(image, "a pending image must not be treated as failed").not.toBeNull();

      fireEvent.error(image!);

      expect(fallbackText()).not.toBeNull();
      expect(poster()).toBeNull();
      expect(downloadLink()).toBeNull();
    });
  });
});
