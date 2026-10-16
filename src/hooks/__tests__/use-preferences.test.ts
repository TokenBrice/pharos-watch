// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { waitFor } from "@testing-library/react";

import {
  DEFAULT_VISIBLE_COLUMNS,
  MOBILE_DEFAULT_COLUMNS,
  normalizeVisibleColumns,
  usePreference,
} from "@/hooks/use-preferences";

function renderToStringWithoutWindow(element: React.ReactElement): string {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: undefined,
  });
  try {
    return renderToString(element);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
}

describe("normalizeVisibleColumns", () => {
  it("keeps locked columns, drops invalid values, and de-duplicates by canonical order", () => {
    expect(
      normalizeVisibleColumns(["flags", "bogus", "mcap", "rank", "flags"], DEFAULT_VISIBLE_COLUMNS),
    ).toEqual(["rank", "name", "mcap", "flags"]);
  });
});

describe("usePreference", () => {
  function PreferenceProbe({ storageKey }: { storageKey: string }) {
    const [columns] = usePreference(storageKey, MOBILE_DEFAULT_COLUMNS, {
      decode: (raw) => normalizeVisibleColumns(raw, MOBILE_DEFAULT_COLUMNS),
    });
    return createElement("div", null, columns.join(","));
  }

  it("hydrates from default markup before applying persisted localStorage state", async () => {
    const storageKey = "pharos-table-columns-hydration";
    localStorage.setItem(storageKey, JSON.stringify(["mcap", "bogus", "flags"]));

    const element = createElement(PreferenceProbe, { storageKey });
    const serverHtml = renderToStringWithoutWindow(element);
    expect(serverHtml).toContain(MOBILE_DEFAULT_COLUMNS.join(","));

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    const recoverableErrors: unknown[] = [];
    const root = hydrateRoot(container, element, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });

    await waitFor(() => {
      expect(container.textContent).toBe("rank,name,mcap,flags");
    });
    expect(recoverableErrors).toEqual([]);

    root.unmount();
  });
});
