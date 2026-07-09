// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";

vi.mock("@/lib/analytics", () => ({ trackSearch: vi.fn() }));

function SearchProbe() {
  const { searchInput, deferredSearch } = useUrlSearchSync("test", 60_000);
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "input" }, searchInput),
    createElement("span", { "data-testid": "deferred" }, deferredSearch),
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/compliance/?q=alpha");
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

describe("useUrlSearchSync", () => {
  it("resynchronizes local and deferred search after browser navigation", async () => {
    render(createElement(SearchProbe));
    expect(screen.getByTestId("input").textContent).toBe("alpha");

    await act(async () => {
      window.history.pushState(null, "", "/compliance/?q=beta");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("input").textContent).toBe("beta");
      expect(screen.getByTestId("deferred").textContent).toBe("beta");
    });
  });
});
