import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchEtherfuseCetesSource } from "../yield-sync/sources";
import { parseEtherfuseCetesStablebondPage } from "../yield-sync/etherfuse-cetes";

const ETHERFUSE_CETES_HTML = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      cachedStablebondsLookup: {
        calculatedAt: "2026-05-19T14:24:43.661467807+00:00",
      },
      cachedBonds: [
        {
          issuanceNumber: 110,
          currentIssuance: {
            address: "2p3sFHSkC7f8WoxenAgcpGbKjDYHtAScMuJPft47o5cS",
            startingTokenAmount: "1.162263",
            endingTokenAmount: "1.163506",
            startDate: 1778798112000,
            endDate: 1779402912000,
            interestRateBps: 558,
            status: 1,
          },
          mint: {
            symbol: "CETES",
            currentTokenAmount: "1.163091",
          },
        },
      ],
    },
  },
})}</script></body></html>`;

describe("fetchEtherfuseCetesSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("publishes Etherfuse CETES current issuance as the canonical protocol source", async () => {
    mockYieldSourceRoutes([
      {
        match: "app.etherfuse.com/bonds/cetes",
        body: ETHERFUSE_CETES_HTML,
        headers: { "Content-Type": "text/html" },
      },
    ]);

    const result = await fetchEtherfuseCetesSource();

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: 5.58,
        apyBase: 5.58,
        apyReward: null,
        sourcePool: "2p3sFHSkC7f8WoxenAgcpGbKjDYHtAScMuJPft47o5cS",
        sourceTvlUsd: null,
        dataSource: "protocol-api",
        exchangeRate: 1.163091,
        sourceKey: "protocol-api:etherfuse-cetes-current-issuance",
        yieldSource: "Etherfuse CETES current issuance",
        yieldType: "nav-appreciation",
        sourceObservedAt: 1779200683,
        comparisonAnchorObservedAt: null,
      }),
    );
  });

  it("returns null when Etherfuse does not expose a usable CETES rate", async () => {
    mockYieldSourceRoutes([
      {
        match: "app.etherfuse.com/bonds/cetes",
        body: "<html></html>",
        headers: { "Content-Type": "text/html" },
      },
    ]);

    await expect(fetchEtherfuseCetesSource()).resolves.toBeNull();
  });

  it("preserves parseFloat suffix coercion before epoch normalization", () => {
    const html = ETHERFUSE_CETES_HTML
      .replace("1778798112000", '"1778798112000ms"')
      .replace("1779402912000", '"1779402912000ms"');

    expect(parseEtherfuseCetesStablebondPage(html)).toMatchObject({
      startSec: 1_778_798_112,
      endSec: 1_779_402_912,
      recordDate: "2026-05-14",
    });
  });
});
