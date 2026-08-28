// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createPharosQueryClient, Providers, SORT_COLUMN_EVENT, type SortColumnEventDetail } from "@/components/providers";
import { setSidebarShortcutDisabled } from "@/lib/keyboard-shortcut-settings";

vi.mock("next/dynamic", () => ({
  default: (loader: () => unknown) => {
    const source = String(loader);
    if (source.includes("keyboard-shortcuts")) {
      function MockKeyboardShortcuts({ open }: { open: boolean }) {
        return open ? <div data-testid="keyboard-shortcuts-dialog" /> : null;
      }
      return MockKeyboardShortcuts;
    }
    return function MockDynamic() {
      return null;
    };
  },
}));

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/components/route-progress-bar", () => ({
  RouteProgressBar: () => null,
}));

function pressKey(key: string) {
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  window.localStorage.clear();
});

describe("Providers single-key shortcuts (WCAG 2.1.4 disable flag)", () => {
  it("does not refetch cached queries on window focus by default", () => {
    const client = createPharosQueryClient();

    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });

  it("broadcasts numeric column sort when single-key shortcuts are enabled", () => {
    const onSort = vi.fn();
    window.addEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    try {
      render(
        <Providers>
          <div />
        </Providers>,
      );

      const event = pressKey("3");

      expect(onSort).toHaveBeenCalledTimes(1);
      const detail = (onSort.mock.calls[0][0] as CustomEvent<SortColumnEventDetail>).detail;
      expect(detail.columnNumber).toBe(3);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    }
  });

  it("ignores numeric column sort when single-key shortcuts are disabled", () => {
    setSidebarShortcutDisabled(true);
    const onSort = vi.fn();
    window.addEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    try {
      render(
        <Providers>
          <div />
        </Providers>,
      );

      const event = pressKey("3");

      expect(onSort).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener(SORT_COLUMN_EVENT, onSort as EventListener);
    }
  });

  it("opens the shortcuts dialog on ? when single-key shortcuts are enabled", async () => {
    render(
      <Providers>
        <div />
      </Providers>,
    );

    const event = pressKey("?");

    expect(await screen.findByTestId("keyboard-shortcuts-dialog")).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores ? when single-key shortcuts are disabled", () => {
    setSidebarShortcutDisabled(true);
    render(
      <Providers>
        <div />
      </Providers>,
    );

    const event = pressKey("?");

    expect(screen.queryByTestId("keyboard-shortcuts-dialog")).toBeNull();
    expect(event.defaultPrevented).toBe(false);
  });
});
