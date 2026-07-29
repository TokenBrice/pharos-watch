import { describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import type { SelectorInput } from "@shared/lib/selector/types";
import { makeReportCardsV9Response } from "../../src/test/fixtures/safety-score-v9";
import { recomputeVerifiedSelectorSnapshot } from "../lib/selector-canonical-snapshot";

const input = {
  profile: "treasury",
  pegCurrency: "USD",
  horizon: "6mplus",
  depegTolerance: "zero",
  composability: "none",
  exitSpeed: "any",
  venuePreferences: ["custody"],
  minApy: null,
  yieldNativeOnly: false,
  decentralization: "any",
  custodyOk: "any",
} satisfies SelectorInput;

function methodology(version: string) {
  return {
    version,
    versionLabel: version,
    currentVersion: version,
    currentVersionLabel: version,
    changelogPath: "/methodology/changelog/",
    asOf: 1_700_000_000,
    isCurrent: true,
  };
}

function redemptionMethodology() {
  return {
    ...methodology("redemption-v1"),
    componentWeights: {
      access: 0.2,
      settlement: 0.15,
      executionCertainty: 0.15,
      capacity: 0.25,
      outputAssetQuality: 0.15,
      cost: 0.1,
    },
    effectiveExitModel: {
      model: "test",
      diversificationFactor: 1,
    },
    routeFamilyCaps: {
      queueRedeem: 80,
      offchainIssuer: 100,
    },
  };
}

function canonicalPayloads(reportCardsPayload: unknown = makeReportCardsV9Response()) {
  return new Map<string, unknown>([
    [API_PATHS.stablecoins(), { peggedAssets: [] }],
    [API_PATHS.pegSummary(), { coins: [], summary: null, methodology: methodology("peg-v3") }],
    [API_PATHS.reportCardsV9(), reportCardsPayload],
    [
      API_PATHS.stressSignals(),
      {
        signals: {},
        updatedAt: 1_700_000_000,
        methodology: methodology("dews-v3"),
      },
    ],
    [API_PATHS.dexLiquidity(), {}],
    [
      API_PATHS.yieldRankings(),
      {
        rankings: [],
        riskFreeRate: 0,
        scalingFactor: 1,
        medianApy: 0,
        updatedAt: 1_700_000_000,
        methodology: methodology("yield-v8"),
      },
    ],
    [API_PATHS.bluechipRatings(), {}],
    [
      API_PATHS.redemptionBackstops(),
      {
        coins: {},
        methodology: redemptionMethodology(),
        updatedAt: 1_700_000_000,
      },
    ],
  ]);
}

function installFetchMock(payloads: ReadonlyMap<string, unknown>) {
  const fetchMock = vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const href = typeof url === "string" || url instanceof URL ? String(url) : url.url;
    const parsed = new URL(href);
    const payload = payloads.get(parsed.pathname);
    if (payload === undefined) {
      return Promise.resolve(jsonResponse({ error: "not found" }, 404));
    }
    return Promise.resolve(jsonResponse(payload));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("canonical selector snapshot recomputation", () => {
  it("recomputes a verified selector snapshot from canonical V9 sources", async () => {
    const fetchMock = installFetchMock(canonicalPayloads());

    const output = await recomputeVerifiedSelectorSnapshot(
      input,
      new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
      {
        SITE_API_ORIGIN: "https://site-api.pharos.watch",
        SITE_API_SHARED_SECRET: "test-secret",
      },
      1_700_000_000_000,
    );

    expect(output.provenance).toBe("pharos-verified");
    expect(output.snapshotSchemaVersion).toBe(3);
    expect(output.verification).toMatchObject({
      kind: "pharos-server-recomputed-v1",
      datasetHash: output.datasetHash,
      engineVersion: output.engineVersion,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://site-api.pharos.watch/api/report-cards/v9",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const reportCardsFetch = fetchMock.mock.calls.find(([url]) => String(url).endsWith(API_PATHS.reportCardsV9()));
    expect((reportCardsFetch?.[1]?.headers as Headers).get(SITE_DATA_PROXY_SECRET_HEADER)).toBe("test-secret");

    vi.unstubAllGlobals();
  });

  it("rejects a canonical source that does not satisfy the V9 report-card contract", async () => {
    installFetchMock(canonicalPayloads({ cards: [] }));

    await expect(
      recomputeVerifiedSelectorSnapshot(
        input,
        new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
        {
          SITE_API_ORIGIN: "https://site-api.pharos.watch",
          SITE_API_SHARED_SECRET: "test-secret",
        },
        1_700_000_000_000,
      ),
    ).rejects.toThrow("Canonical selector source contract failed: /api/report-cards/v9");

    vi.unstubAllGlobals();
  });
});
