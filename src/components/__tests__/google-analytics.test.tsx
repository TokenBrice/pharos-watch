// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAnalytics } from "@/components/google-analytics";

const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: pathnameMock,
}));

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  delete window.dataLayer;
  delete window.gtag;
  pathnameMock.mockReset();
});

describe("GoogleAnalytics", () => {
  it("queues native gtag arguments objects so gtag.js can emit collect hits", async () => {
    pathnameMock.mockReturnValue("/");

    render(<GoogleAnalytics measurementId="G-TEST" />);

    await waitFor(() => expect(window.dataLayer?.length).toBeGreaterThanOrEqual(4));

    const entries = window.dataLayer ?? [];
    expect(entries.every((entry) => !Array.isArray(entry))).toBe(true);
    expect(Array.from(entries[0] ?? [])).toEqual([
      "consent",
      "default",
      {
        ad_storage: "denied",
        analytics_storage: "granted",
        ad_user_data: "denied",
        ad_personalization: "denied",
      },
    ]);
    expect(Array.from(entries[2] ?? [])).toEqual(["config", "G-TEST", { send_page_view: false }]);
    expect(Array.from(entries[3] ?? [])).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/" }),
    ]);
    expect(document.getElementById("pharos-google-analytics")).toHaveProperty(
      "src",
      "https://www.googletagmanager.com/gtag/js?id=G-TEST",
    );
  });

  it("tracks SPA path changes after bootstrap", async () => {
    pathnameMock.mockReturnValue("/");
    const view = render(<GoogleAnalytics measurementId="G-TEST" />);

    await waitFor(() => expect(window.dataLayer?.length).toBeGreaterThanOrEqual(4));
    pathnameMock.mockReturnValue("/liquidity/");
    view.rerender(<GoogleAnalytics measurementId="G-TEST" />);

    await waitFor(() => expect(window.dataLayer?.length).toBeGreaterThanOrEqual(5));
    const lastEntry = Array.from(window.dataLayer?.at(-1) ?? []);
    expect(lastEntry).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/liquidity/" }),
    ]);
  });
});
