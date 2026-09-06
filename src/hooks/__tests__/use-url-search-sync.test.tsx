// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlSearchSync } from "@/hooks/use-url-search-sync";
import { clearAllTrackingTimers } from "@/lib/analytics";

function SearchProbe() {
  const { getParam, setParam } = useUrlFilters();
  const { searchInput, setSearchInput, deferredSearch } = useUrlSearchSync(
    "test",
    { getParam, setParam },
    300,
  );
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "input" }, searchInput),
    createElement("span", { "data-testid": "deferred" }, deferredSearch),
    createElement("input", {
      "aria-label": "Search",
      value: searchInput,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSearchInput(event.target.value),
    }),
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/compliance/?q=alpha");
  window.gtag = vi.fn();
});

afterEach(() => {
  cleanup();
  clearAllTrackingTimers();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete window.gtag;
});

describe("useUrlSearchSync", () => {
  it("does not track initial URL queries or browser history changes", () => {
    vi.useFakeTimers();
    render(createElement(SearchProbe));
    act(() => { vi.advanceTimersByTime(2000); });
    expect(window.gtag).not.toHaveBeenCalled();
    act(() => {
      window.history.pushState(null, "", "/compliance/?q=beta");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByTestId("input").textContent).toBe("beta");
    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("debounces manual input, sends only its length, and cancels clearing or navigation", () => {
    vi.useFakeTimers();
    render(createElement(SearchProbe));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private search" } });
    act(() => { vi.advanceTimersByTime(500); });
    expect(new URL(window.location.href).searchParams.get("q")).toBe("private search");
    expect(window.gtag).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "private search revised" } });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(window.gtag).toHaveBeenCalledExactlyOnceWith("event", "search_performed", {
      page: "test", query_length: "private search revised".length,
    });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cancel me" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(window.gtag).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "leaving" } });
    clearAllTrackingTimers();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(window.gtag).toHaveBeenCalledTimes(1);
  });

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
