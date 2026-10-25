import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StaleDataBanner } from "@/components/stale-data-banner";

vi.mock("@/hooks/use-freshness-boundary", () => ({ useFreshnessBoundary: () => Date.now() }));

const STALE_TIME = 15 * 60_000;

describe("StaleDataBanner first-fetch handling", () => {
  it("excludes an old seed only while awaiting its first live read", () => {
    const seed = { preset: "stablecoins" as const, dataUpdatedAt: Date.now() - 5 * 3600_000, hasData: true };
    expect(renderToStaticMarkup(<StaleDataBanner queries={[{ ...seed, awaitingLiveRead: true }]} />)).toBe("");
    expect(renderToStaticMarkup(<StaleDataBanner queries={[{ ...seed, awaitingLiveRead: false }]} />))
      .toContain("Showing an older snapshot");
  });

  it("does not hide a settled failure even if the caller still marks the seed as awaiting", () => {
    const html = renderToStaticMarkup(<StaleDataBanner queries={[{
      preset: "stablecoins", dataUpdatedAt: Date.now() - 5 * 3600_000, hasData: true,
      awaitingLiveRead: true, error: new Error("offline"),
    }]} />);
    expect(html).toContain("Showing an older snapshot");
  });

  it("keeps evaluating ordinary retained data during a refetch", () => {
    const html = renderToStaticMarkup(<StaleDataBanner queries={[{
      preset: "stablecoins", dataUpdatedAt: Date.now() - 5 * 3600_000, hasData: true, isLoading: true,
    }]} />);
    expect(html).toContain("Showing an older snapshot");
  });

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

  it("infers an in-flight first fetch when the caller omits isLoading", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner
        queries={[
          { label: "Mint/Burn Flows", dataUpdatedAt: 0, staleTime: STALE_TIME, hasData: false },
          { label: "Peg Summary", dataUpdatedAt: 0, staleTime: STALE_TIME },
        ]}
      />,
    );

    expect(html).toBe("");
  });

  it("still names an empty read that settled when isLoading is omitted", () => {
    const html = renderToStaticMarkup(
      <StaleDataBanner queries={[{ label: "Report Cards", dataUpdatedAt: Date.now(), staleTime: STALE_TIME, hasData: false }]} />,
    );

    expect(html).toContain("Report Cards has not populated yet");
  });

});
