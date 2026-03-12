import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { ApiFetchError } from "@/lib/api";
import { OverviewSection } from "@/components/stablecoin-detail/overview-section";

describe("OverviewSection", () => {
  it("surfaces live-reserve API failures when falling back to curated reserve metadata", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="iusd-infinifi"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: coin!.reserves ?? [{ name: "Curated fallback", pct: 100, risk: "low" }],
          estimated: false,
          mode: "curated-fallback",
        }}
        reserveFetchError={new ApiFetchError("/api/stablecoin-reserves/iusd-infinifi", 503, null)}
        isNavToken
      />,
    );

    expect(html).toContain("Live reserve feed unavailable");
    expect(html).toContain("Showing curated reserve baseline");
  });

  it("surfaces refresh delays when an existing live snapshot cannot be refreshed", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <OverviewSection
        stablecoinId="iusd-infinifi"
        coin={coin!}
        summary={null}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
        }}
        reserveFetchError={new TypeError("Failed to fetch")}
        isNavToken
      />,
    );

    expect(html).toContain("Live reserve refresh delayed");
    expect(html).toContain("last worker-resolved reserve snapshot");
  });
});
