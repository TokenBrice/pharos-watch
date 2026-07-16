import { describe, expect, it } from "vitest";
import {
  applyNonOkProviderDiagnostic,
  buildBlockedProviderDiagnostic,
  buildNoCandidatesDiagnostic,
  buildPricingProviderDiagnostic,
} from "../pricing-provider-lifecycle";
import {
  appendPricingAssetAttempts,
  createPricingAssetAttempt,
  MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC,
} from "../pricing-provider-diagnostics";

describe("pricing provider lifecycle helpers", () => {
  it("bounds and sanitizes asset-attributable pricing attempts", () => {
    const attempts = Array.from({ length: MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC + 5 }, (_, index) => (
      createPricingAssetAttempt({
        assetId: `asset-${index}\nsecret`,
        adapter: "coinmarketcap\tadapter",
        target: `slug:asset-${index}`,
        state: "attempted",
        result: "unresolved",
        candidateAt: 1_800_000_000.9,
      })
    ));
    const bounded: typeof attempts = [];

    appendPricingAssetAttempts(bounded, attempts);

    expect(bounded).toHaveLength(MAX_ASSET_ATTEMPTS_PER_DIAGNOSTIC);
    expect(bounded[0]).toMatchObject({
      assetId: "asset-0secret",
      adapter: "coinmarketcapadapter",
      candidateAt: 1_800_000_000,
      replaySafe: false,
    });
  });

  it("builds no-candidate diagnostics with the recovery shape", () => {
    expect(buildNoCandidatesDiagnostic({
      source: "jupiter",
      stage: "no-candidates",
      endpoint: "none",
    })).toEqual({
      source: "jupiter",
      stage: "no-candidates",
      endpoint: "none",
      status: null,
      ok: true,
      success: true,
      candidateCount: 0,
    });
  });

  it("builds blocked diagnostics with a normalized rejection count", () => {
    expect(buildBlockedProviderDiagnostic({
      source: "coinmarketcap",
      stage: "fallback",
      endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
      candidateCount: 3,
    }, "CoinMarketCap circuit open")).toMatchObject({
      source: "coinmarketcap",
      stage: "fallback",
      ok: false,
      success: false,
      candidateCount: 3,
      errorClass: "blocked",
      errorMessage: "CoinMarketCap circuit open",
      rejectionReasonCounts: { blocked: 1 },
    });
  });

  it("captures non-OK snippets and rejection counts", async () => {
    const diagnostic = buildPricingProviderDiagnostic({
      source: "dexscreener-search",
      stage: "fallback",
      endpoint: "api.dexscreener.com/latest/dex/search",
      candidateCount: 1,
    }, {
      status: 403,
      ok: false,
    });

    await expect(applyNonOkProviderDiagnostic(
      diagnostic,
      new Response("blocked by provider", { status: 403 }),
    )).resolves.toMatchObject({
      status: 403,
      ok: false,
      success: false,
      snippet: "blocked by provider",
      rejectionReasonCounts: { "non-ok": 1 },
    });
  });
});
