// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { act, waitFor } from "@testing-library/react";
import { DataHealthBanner } from "@/components/data-health-banner";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { deriveDataHealth } from "@/lib/data-health";

afterEach(() => vi.restoreAllMocks());

async function hydrateSavedHtml(html: string, element: ReactElement, expectedText: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const errors: unknown[] = [];
  const root = hydrateRoot(container, element, { onRecoverableError: (error) => errors.push(error) });
  try {
    await waitFor(() => expect(container.textContent).toContain(expectedText));
    expect(errors).toEqual([]);
  } finally {
    await act(() => root.unmount());
  }
}

describe("data-health hydration", () => {
  const savedAt = Date.parse("2026-09-06T12:00:00Z");

  it("hydrates a saved fresh query before reclassifying it against the later browser clock", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const element = <StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000, hasData: true,
    }]} />;
    const html = renderToString(element);
    now.mockReturnValue(savedAt + 6 * 3600_000);

    await hydrateSavedHtml(html, element, "Showing an older snapshot");
  });

  it("hydrates a timestamp across browser timezones before displaying the local time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(savedAt);
    let timeZone = "UTC";
    const original = Date.prototype.toLocaleString;
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date, locale, options) {
      return original.call(this, locale ?? "en-US", { ...options, timeZone: options?.timeZone ?? timeZone });
    });
    const element = <DataHealthBanner showFreshTimestamp entries={[deriveDataHealth({
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000, hasData: true,
    })]} />;
    const html = renderToString(element);
    expect(html).toContain("UTC");
    timeZone = "America/Los_Angeles";

    await hydrateSavedHtml(html, element, "5:00 AM PDT");
  });

  it("preserves saved-data errors in server HTML", () => {
    vi.spyOn(Date, "now").mockReturnValue(savedAt);
    const html = renderToString(<StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 15 * 60_000,
      hasData: true, error: new Error("offline"),
    }]} />);
    expect(html).toContain("Refresh failed; showing saved data");
    expect(html).toContain("Last successful update:");
  });

  it("preserves producer age relative to the saved query receipt in server HTML", () => {
    const html = renderToString(<StaleDataBanner queries={[{
      label: "Liquidity", dataUpdatedAt: savedAt, staleTime: 3600_000, hasData: true,
      meta: { updatedAt: (savedAt - 9 * 3600_000) / 1000, ageSeconds: 9 * 3600, status: "degraded" },
    }]} />);
    expect(html).toContain("Live refresh is running behind");
    expect(html).toContain("Last successful update:");
  });
});
