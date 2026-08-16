import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import type { SelectorInput } from "@shared/lib/selector/types";
import { makeReportCardsV9Response } from "../../src/test/fixtures/safety-score-v9";
import { mockFetch } from "@shared/test-utils/mock-fetch";
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

describe("canonical selector snapshot recomputation", () => {
  afterEach(() => {
    // The shared helper installs a global fetch spy by default.
    vi.unstubAllGlobals();
  });

  it("recomputes a verified selector snapshot from canonical V9 sources", async () => {
    const fetchMock = mockFetch(
      [...canonicalPayloads()].map(([path, body]) => ({
        match: `https://site-api.pharos.watch${path}`,
        body,
      })),
      { requireMatch: true, strictUrl: true },
    );

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
    const reportCardsFetch = fetchMock.getHistory().find(({ url }) => url.endsWith(API_PATHS.reportCardsV9()));
    expect(reportCardsFetch).toMatchObject({
      url: "https://site-api.pharos.watch/api/report-cards/v9",
      method: "GET",
    });
    expect(reportCardsFetch?.headers[SITE_DATA_PROXY_SECRET_HEADER.toLowerCase()]).toBe("test-secret");
  });

  it("rejects a canonical source that does not satisfy the V9 report-card contract", async () => {
    mockFetch(
      [...canonicalPayloads({ cards: [] })].map(([path, body]) => ({
        match: `https://site-api.pharos.watch${path}`,
        body,
      })),
      { requireMatch: true, strictUrl: true },
    );

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

  });
});
