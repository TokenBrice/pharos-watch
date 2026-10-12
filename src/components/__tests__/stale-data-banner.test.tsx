import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaleDataBanner } from "@/components/stale-data-banner";

const STALE_TIME = 15 * 60_000;

describe("StaleDataBanner first-fetch handling", () => {
  it("does not report a source as unpopulated while its first fetch is in flight", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner queries={[{ label: "Report Cards", dataUpdatedAt: 0, staleTime: STALE_TIME, hasData: false, isLoading: true }]} />,
    );

    expect(html).toBe("");
  });

  it("still names a source that settled without data", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner queries={[{ label: "Report Cards", dataUpdatedAt: 0, staleTime: STALE_TIME, hasData: false, isLoading: false }]} />,
    );

    expect(html).toContain("Waiting for initial data");
    expect(html).toContain("Report Cards has not populated yet");
  });

  it("never hides a failed read behind the loading state", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner
        queries={[{
          label: "Report Cards",
          dataUpdatedAt: 0,
          staleTime: STALE_TIME,
          hasData: false,
          isLoading: true,
          error: new Error("network"),
        }]}
      />,
    );

    expect(html).toContain("Refresh failed");
  });

  it("keeps reporting the other sources while one is still loading", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner
        queries={[
          { label: "Report Cards", dataUpdatedAt: 0, staleTime: STALE_TIME, hasData: false, isLoading: true },
          { label: "Peg Summary", dataUpdatedAt: 0, staleTime: STALE_TIME, hasData: false, isLoading: false },
        ]}
      />,
    );

    expect(html).toContain("Peg Summary has not populated yet");
    expect(html).not.toContain("Report Cards");
  });
});
