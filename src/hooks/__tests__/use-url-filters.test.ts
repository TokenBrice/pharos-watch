// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUrlFilterClearValue, useUrlFilters } from "@/hooks/use-url-filters";

function UrlFilterProbe() {
  const { searchParams } = useUrlFilters();
  return createElement("div", { "data-testid": "peg-filter" }, searchParams.get("peg") ?? "");
}

function LateCommittedUrlProbe({ nextUrl }: { nextUrl: string }) {
  const { searchParams } = useUrlFilters();
  useLayoutEffect(() => {
    window.history.replaceState(null, "", nextUrl);
  }, [nextUrl]);
  return createElement("div", { "data-testid": "peg-filter" }, searchParams.get("peg") ?? "");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
});

describe("isUrlFilterClearValue", () => {
  it("clears only explicit global sentinel values", () => {
    expect(isUrlFilterClearValue("")).toBe(true);
    expect(isUrlFilterClearValue("all")).toBe(true);
  });

  it("preserves numeric and non-sentinel string values", () => {
    expect(isUrlFilterClearValue("1")).toBe(false);
    expect(isUrlFilterClearValue("0")).toBe(false);
    expect(isUrlFilterClearValue("USD")).toBe(false);
  });
});

describe("useUrlFilters", () => {
  it("syncs search params after same-page history navigation", async () => {
    render(createElement(UrlFilterProbe));

    expect(screen.getByTestId("peg-filter").textContent).toBe("");

    await act(async () => {
      window.history.pushState(null, "", "/?peg=fiat-non-usd-peg#home-alt-rankings");
      await Promise.resolve();
    });

    expect(screen.getByTestId("peg-filter").textContent).toBe("fiat-non-usd-peg");
  });

  it("syncs the current browser URL after a route commits during mount", async () => {
    render(createElement(LateCommittedUrlProbe, { nextUrl: "/screener/?peg=USD" }));

    await waitFor(() => {
      expect(screen.getByTestId("peg-filter").textContent).toBe("USD");
    });
  });

  it("does not clobber a later history wrapper during teardown", () => {
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const view = render(createElement(UrlFilterProbe));
    const urlFilterPushState = window.history.pushState;
    const urlFilterReplaceState = window.history.replaceState;

    const laterPushState: History["pushState"] = function (this: History, data, unused, url) {
      return urlFilterPushState.call(this, data, unused, url);
    };
    const laterReplaceState: History["replaceState"] = function (this: History, data, unused, url) {
      return urlFilterReplaceState.call(this, data, unused, url);
    };

    try {
      window.history.pushState = laterPushState;
      window.history.replaceState = laterReplaceState;

      view.unmount();

      expect(window.history.pushState).toBe(laterPushState);
      expect(window.history.replaceState).toBe(laterReplaceState);

      window.history.pushState(null, "", "/?peg=USD");
      expect(window.location.search).toBe("?peg=USD");
    } finally {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
    }
  });
});
