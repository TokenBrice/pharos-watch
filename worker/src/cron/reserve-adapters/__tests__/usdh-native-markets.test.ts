import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { adaptUsdhNativeMarkets } from "../usdh-native-markets";
import { runAdapter } from "./reserve-adapter.test-support";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SAMPLE_HTML = readFileSync(join(FIXTURES_DIR, "usdh-native-markets.html"), "utf8");

const RESERVES_PAGE = "https://usdh.example/reserves";
const NATIVE_MARKETS_CONFIG: LiveReservesConfig = {
  adapter: "usdh-native-markets",
  version: 1,
  semantics: "attestation-mix",
  inputs: { primary: { kind: "http-html", url: RESERVES_PAGE } },
};
const NATIVE_MARKETS_COIN = {
  id: "usdh-native-markets",
  name: "USDH Stablecoin",
  symbol: "USDH",
  liveReservesConfig: NATIVE_MARKETS_CONFIG,
} as unknown as StablecoinMeta;
describe("adaptUsdhNativeMarkets", () => {
  it("emits a single reviewed-attestation slice at risk low", () => {
    const result = adaptUsdhNativeMarkets(SAMPLE_HTML);
    expect(result.slices).toEqual([
      {
        name: "Reviewed attestation reserves (cash / T-Bills / custody)",
        pct: 100,
        risk: "low",
      },
    ]);
  });

  it("picks the latest attestation link by (year, month) and derives end-of-month timestamp", () => {
    const result = adaptUsdhNativeMarkets(SAMPLE_HTML);
    // Fixture has attestations through April 2026; latest = 2026_april.pdf -> Apr 30, 2026.
    expect(result.metadata).toMatchObject({
      attestationPeriod: "April 2026",
      attestationPdfPath: "/attestations/2026_april.pdf",
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
      freshnessMode: "verified",
      redemption: {
        capacityKind: "documented-bound",
        freshnessKind: "verified-source-timestamp",
        sourceTimestamp: Date.UTC(2026, 3, 30) / 1000,
        routeStatus: "unknown",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("throws layout-changed when no /attestations/YYYY_<month>.pdf link is present", () => {
    const emptyHtml = "<html><body><p>No attestations published yet.</p></body></html>";
    expect(() => adaptUsdhNativeMarkets(emptyHtml)).toThrow("layout-changed");
  });

  it("prefers the greater month when multiple entries share the latest year", () => {
    const html = `
      <a href="/attestations/2026_february.pdf">View</a>
      <a href="/attestations/2026_january.pdf">View</a>
      <a href="/attestations/2025_december.pdf">View</a>
    `;
    const result = adaptUsdhNativeMarkets(html);
    expect(result.metadata?.attestationPeriod).toBe("February 2026");
    expect(result.metadata?.attestationPdfPath).toBe("/attestations/2026_february.pdf");
  });

  it("prefers the greater year even when a later month exists in an earlier year", () => {
    const html = `
      <a href="/attestations/2026_january.pdf">View</a>
      <a href="/attestations/2025_december.pdf">View</a>
    `;
    const result = adaptUsdhNativeMarkets(html);
    expect(result.metadata?.attestationPeriod).toBe("January 2026");
  });
});
describe("fetchUsdhNativeMarketsReserves", () => {
  it("fetches the configured page through the shared network boundary", async () => {
    const { result } = await runAdapter(NATIVE_MARKETS_CONFIG.adapter, NATIVE_MARKETS_COIN, {
      network: { html: { [RESERVES_PAGE]: SAMPLE_HTML } },
      nowSec: Date.UTC(2026, 3, 30, 1) / 1_000,
    });

    expect(result.metadata).toMatchObject({
      attestationPeriod: "April 2026",
      sourceTimestamp: Date.UTC(2026, 3, 30) / 1_000,
    });
  });
});
