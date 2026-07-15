import { describe, expect, it, vi } from "vitest";
import {
  auditBinance,
  auditBitstamp,
  auditCoinbase,
  auditOptionalSourceShapes,
  runPricingProviderAudit,
} from "../maintenance/audit-pricing-provider-config";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("audit-pricing-provider-config", () => {
  it("reports configured Binance pairs as present", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      symbols: [
        { symbol: "USDTUSD", status: "TRADING" },
        { symbol: "USDCUSD", status: "TRADING" },
      ],
    }));

    await expect(auditBinance(fetchImpl as typeof fetch)).resolves.toMatchObject({
      provider: "binance",
      ok: true,
      checked: 2,
      missing: [],
    });
  });

  it("treats Binance regional blocking as a skipped successful live audit", async () => {
    const fetchImpl = vi.fn(async () => new Response("blocked", { status: 451 }));

    await expect(auditBinance(fetchImpl as typeof fetch)).resolves.toMatchObject({
      provider: "binance",
      ok: true,
      missing: [],
      notes: [expect.stringContaining("451")],
    });
  });

  it("treats Bitstamp runner network failures as a skipped successful live audit", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(auditBitstamp(fetchImpl as typeof fetch)).resolves.toMatchObject({
      provider: "bitstamp",
      ok: true,
      missing: [],
      notes: [expect.stringContaining("fetch failed")],
    });
  });

  it("throws on provider metadata parse or shape failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ products: [] }));

    await expect(auditCoinbase(fetchImpl as typeof fetch)).rejects.toThrow(
      "coinbase metadata shape drift",
    );
  });

  it("fails the aggregate audit when a configured provider is missing pairs", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("binance")) {
        return jsonResponse({ symbols: [{ symbol: "USDTUSD", status: "TRADING" }] });
      }
      if (href.includes("kraken")) {
        return jsonResponse({
          error: [],
          result: {
            DAIUSD: { altname: "DAIUSD", wsname: "DAI/USD" },
            EURCUSD: { altname: "EURCUSD", wsname: "EURC/USD" },
            EURRUSD: { altname: "EURRUSD", wsname: "EURR/USD" },
            PAXGUSD: { altname: "PAXGUSD", wsname: "PAXG/USD" },
            PYUSDUSD: { altname: "PYUSDUSD", wsname: "PYUSD/USD" },
            TGBPUSD: { altname: "TGBPUSD", wsname: "TGBP/USD" },
            USD1USD: { altname: "USD1USD", wsname: "USD1/USD" },
            USDCUSD: { altname: "USDCUSD", wsname: "USDC/USD" },
            USDSUSD: { altname: "USDSUSD", wsname: "USDS/USD" },
            USDTUSD: { altname: "USDTUSD", wsname: "USDT/USD" },
          },
        });
      }
      if (href.includes("bitstamp")) {
        return jsonResponse([
          { name: "DAI/USD", trading: "Enabled" },
          { name: "PYUSD/USD", trading: "Enabled" },
          { name: "USDC/USD", trading: "Enabled" },
          { name: "USDT/USD", trading: "Enabled" },
        ]);
      }
      if (href.includes("coinbase")) {
        return jsonResponse([
          { id: "USDT-USD", status: "online" },
          { id: "PAXG-USD", status: "online" },
          { id: "USDS-USD", status: "online" },
          { id: "USD1-USD", status: "online" },
          { id: "HONEY-USD", status: "online" },
        ]);
      }
      if (href.includes("redstone")) {
        return jsonResponse({
          ALUSD: {},
          aUSD: {},
          CETES: {},
          DAI: {},
          EUROC: {},
          eUSD: {},
          FDUSD: {},
          FRAX: {},
          frxUSD: {},
          GHO: {},
          HONEY: {},
          LUSD: {},
          PYUSD: {},
          USD1: {},
          USDC: {},
          USDH: {},
          USDT: {},
          USDe: {},
          XAUt: {},
          crvUSD: {},
          fxUSD: {},
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(runPricingProviderAudit({ fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      "provider config drift detected: binance",
    );
  });

  it("can run optional live source-shape checks against mocked responses", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("api.jup.ag")) {
        return jsonResponse({ SOL: { usdPrice: 150.25, blockId: 123 } });
      }
      if (href.includes("coinmarketcap")) {
        return jsonResponse({ data: { coins: [{ slug: "tether", symbol: "USDT", quote: { USD: { price: 1 } } }] } });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(auditOptionalSourceShapes({
      fetchImpl: fetchImpl as typeof fetch,
      cmcApiKey: "test",
    })).resolves.toEqual([
      expect.objectContaining({ provider: "jupiter-shape", ok: true }),
      expect.objectContaining({ provider: "coinmarketcap-shape", ok: true }),
    ]);
  });
});
