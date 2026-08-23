// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ApiFetchError } from "@/lib/api";
import { ReservePanel } from "@/components/stablecoin-detail/reserve-panel";
import { makeReserveResponse, renderReservePanelStatic } from "./reserve-panel-test-support";

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("ReservePanel", () => {
  it("surfaces live-reserve API failures when falling back to curated reserve metadata", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderReservePanelStatic({
      coin: coin!,
      reserves: makeReserveResponse({
        reserves: coin!.reserves ?? [{ name: "Curated fallback", pct: 100, risk: "low" }],
        mode: "curated-fallback",
        source: undefined,
        liveAt: undefined,
      }),
      reserveFetchError: new ApiFetchError("/api/stablecoin-reserves/iusd-infinifi", 503, null),
    });

    expect(html).toContain("Live reserve feed unavailable");
    expect(html).toContain("Showing curated reserve baseline");
  });

  it("surfaces refresh delays when an existing live snapshot cannot be refreshed", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
        }}
        reserveFetchError={new TypeError("Failed to fetch")}
      />,
    );

    expect(html).toContain("Live reserve refresh delayed");
    expect(html).toContain("last worker-resolved reserve snapshot");
  });

  it("surfaces active sync failures on fresh live reserve snapshots", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
          sync: {
            enabled: true,
            status: "error",
            stale: false,
            bootstrap: false,
            lastSuccessAt: 1_700_000_000,
            lastAttemptedAt: 1_700_100_000,
            lastError: "HTTP 503 from reserve API",
            failureCategory: "circuit-open",
            uncertainWrite: true,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Live reserve sync error");
    expect(html).toContain("Status: error");
    expect(html).toContain("Failure category: circuit-open");
    expect(html).toContain("Last error: HTTP 503 from reserve API");
    expect(html).toContain("Latest write state uncertain");
    expect(html).toContain(">Updated");
  });

  it("does not render raw reserve sync warnings as public operator notes", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
          sync: {
            enabled: true,
            status: "ok",
            stale: false,
            bootstrap: false,
            lastSuccessAt: 1_700_000_000,
            lastAttemptedAt: 1_700_100_000,
            warnings: ["adapter returned internal retry metadata"],
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).not.toContain("Operator note");
    expect(html).not.toContain("adapter returned internal retry metadata");
    expect(html).toContain(">Updated");
  });

  it("renders independent live reserve provenance messaging", () => {
    const coin = TRACKED_META_BY_ID.get("iusd-infinifi");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Live farm", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "infinifi",
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          provenance: {
            evidenceClass: "independent",
            sourceModel: "dynamic-mix",
            freshnessMode: "unverified",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Independent live reserve disclosure");
    expect(html).toContain("freshness is not verified strongly enough for collateral scoring");
    expect(html).toContain(">Live</span>");
  });

  it("renders a Yield Basis share note when live reserve metadata exposes it", () => {
    const coin = TRACKED_META_BY_ID.get("crvusd-curve");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Custodied BTC (ex: wBTC/cbBTC)", pct: 67, risk: "medium" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "crvusd",
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          metadata: {
            yieldBasisCollateralPct: 89.7,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Yield Basis positions account for 89.7% of this live reserve mix.");
  });

  it("renders separate Source and Evidence links for authoritative live reserve snapshots", () => {
    const coin = TRACKED_META_BY_ID.get("gho-aave");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "stataUSDC GSM", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "gho",
          displayUrl: "https://aave.tokenlogic.xyz/gho",
          evidenceUrls: ["https://aave.com/help/gho-stablecoin/stability-module"],
          displayBadge: {
            kind: "live",
            label: "Live",
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain(">Source</a>");
    expect(html).toContain(">Evidence</a>");
    expect(html).toContain("https://aave.tokenlogic.xyz/gho");
    expect(html).toContain("https://aave.com/help/gho-stablecoin/stability-module");
  });

  it("renders status, source and evidence links, and badge labels accessibly", () => {
    const coin = TRACKED_META_BY_ID.get("gho-aave");
    expect(coin).toBeDefined();

    render(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "stataUSDC GSM", pct: 100, risk: "low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "gho",
          displayUrl: "https://aave.tokenlogic.xyz/gho",
          evidenceUrls: ["https://aave.com/help/gho-stablecoin/stability-module"],
          displayBadge: {
            kind: "live",
            label: "Live",
          },
        }}
        reserveFetchError={new TypeError("Failed to fetch")}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Live reserve refresh delayed");
    expect(screen.getByText("Live")).toBeTruthy();

    // Reserve citations now fold behind the standard `Sources (N)` footer
    // (WS8.13); they stay in the DOM while collapsed.
    const sourcesToggle = screen.getByRole("button", { name: /Sources/ });
    expect(sourcesToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(sourcesToggle);
    expect(screen.getByRole("link", { name: "Source" }).getAttribute("href")).toBe("https://aave.tokenlogic.xyz/gho");
    expect(screen.getByRole("link", { name: "Evidence" }).getAttribute("href")).toBe(
      "https://aave.com/help/gho-stablecoin/stability-module",
    );
  });

  it("renders static-validated reserve provenance messaging", () => {
    const coin = TRACKED_META_BY_ID.get("frax-frax");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Reviewed baseline", pct: 100, risk: "very-low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "frax",
          displayBadge: {
            kind: "curated-validated",
            label: "Curated-Validated",
          },
          provenance: {
            evidenceClass: "static-validated",
            sourceModel: "validated-static",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Curated-validated reserve baseline");
    expect(html).toContain("Curated-Validated");
  });

  it("renders weak-probe reserve provenance messaging", () => {
    const coin = TRACKED_META_BY_ID.get("pyusd-paypal");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Issuer reserves", pct: 100, risk: "very-low" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "single-asset",
          displayBadge: {
            kind: "proof",
            label: "Proof",
          },
          provenance: {
            evidenceClass: "weak-live-probe",
            sourceModel: "single-bucket",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Proof-based reserve view");
    expect(html).toContain("Proof");
  });

  it("renders a live badge for live-fed static-validated sources without calling them curated-validated", () => {
    const coin = TRACKED_META_BY_ID.get("usdd-tron-dao-reserve");
    expect(coin).toBeDefined();

    const html = renderToStaticMarkup(
      <ReservePanel
        coin={coin!}
        reserves={{
          reserves: [{ name: "Tracked vaults", pct: 100, risk: "medium" }],
          estimated: false,
          mode: "live",
          liveAt: 1_700_000_000,
          source: "usdd-data-platform",
          displayBadge: {
            kind: "live",
            label: "Live",
          },
          provenance: {
            evidenceClass: "static-validated",
            sourceModel: "dynamic-mix",
            scoringEligible: false,
          },
        }}
        reserveFetchError={null}
      />,
    );

    expect(html).toContain("Live reserve disclosure");
    expect(html).toContain(">Live</span>");
  });

});
