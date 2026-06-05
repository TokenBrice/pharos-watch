import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/dexscreener", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/dexscreener")>();
  return {
    ...actual,
    fetchDsTokenPoolsWithStatus: vi.fn(),
    dsRateLimit: vi.fn(async () => undefined),
  };
});

import { CIRCUIT_SOURCE } from "../../../lib/constants";
import { fetchDsTokenPoolsWithStatus } from "../../../lib/dexscreener";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { runDexScreenerPass } from "../enrich-prices-dexscreener-pass";
import type { PeggedAsset } from "../enrich-prices";

function makeMissingAsset(overrides: Partial<PeggedAsset> = {}): PeggedAsset {
  return {
    id: "143",
    name: "Verified USD",
    symbol: "USDV",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: null,
    priceSource: "missing",
    priceConfidence: null,
    priceUpdatedAt: null,
    circulating: { peggedUSD: 1_000_000 },
    chainCirculating: {},
    chains: ["Ethereum"],
    ...overrides,
  };
}

describe("runDexScreenerPass", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fetchDsTokenPoolsWithStatus).mockReset();
    vi.unstubAllGlobals();
  });

  it("does not use the retired symbol-search fallback for addressless assets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await runDexScreenerPass([makeMissingAsset()], undefined, undefined);

    expect(result).toMatchObject({ resolved: 0, failures: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("records thrown exact lookups as failed provider outcomes", async () => {
    vi.mocked(fetchDsTokenPoolsWithStatus).mockRejectedValueOnce(new Error("dns failed"));
    const db = mockD1([
      {
        match: "SELECT value, updated_at FROM cache WHERE key = ?",
        matchBinds: [`circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`],
        rows: [],
        first: null,
      },
    ]);

    const result = await runDexScreenerPass([
      makeMissingAsset({
        id: "exact-usd",
        symbol: "EXACT",
        address: "0xabc",
        chains: ["Base"],
      }),
    ], undefined, db);

    expect(result).toMatchObject({
      resolved: 0,
      failures: [],
      diagnostics: [
        expect.objectContaining({
          source: "dexscreener-exact",
          endpoint: "api.dexscreener.com/tokens/v1/base/0xabc",
          ok: false,
          success: false,
          errorClass: "Error",
          errorMessage: "dns failed",
        }),
      ],
    });
    expect(fetchDsTokenPoolsWithStatus).toHaveBeenCalledWith(
      "base",
      "0xabc",
      undefined,
      expect.any(Number),
      0,
    );

    const circuitWrites = db
      .getHistory()
      .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO cache"));
    const exactWrite = circuitWrites.find((entry) =>
      entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_PRICES}`
    );

    expect(JSON.parse(String(exactWrite?.binds[1]))).toMatchObject({
      state: "closed",
      consecutiveFailures: 1,
    });
    expect(circuitWrites.some((entry) =>
      entry.binds[0] === `circuit:${CIRCUIT_SOURCE.DEXSCREENER_SEARCH}`
    )).toBe(false);
  });
});
