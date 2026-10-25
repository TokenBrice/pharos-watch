import { afterEach, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import eursafo from "@shared/data/stablecoins/coins/eursafo-spiko.json";

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: [eursafo] }));

import { fetchFiatCoinGeckoTokens } from "../fiat-cg";
import { reviewedOnchainSupplyHoldFields } from "../../shared";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it("retains fresh CoinGecko supply when an issuer perimeter refuses only its on-chain roster", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(Response.json({ coins: {} }))));
  const nowSec = Math.floor(Date.now() / 1000), marketCap = 1_798_801_917.8;
  const [row] = await fetchFiatCoinGeckoTokens({ [eursafo.geckoId]: {
    usd: 1.14, usd_market_cap: marketCap, last_updated_at: nowSec,
  } });
  expect(row).toMatchObject({ id: eursafo.id, supplySource: "coingecko-fallback", supplyObservedAt: nowSec,
    circulating: { peggedEUR: marketCap }, chainCirculating: {},
  });
  expect(reviewedOnchainSupplyHoldFields(row, nowSec)).toBeNull();
});
