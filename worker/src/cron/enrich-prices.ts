import { DEFILLAMA_COINS, USER_AGENT, DEXSCREENER_MIN_LIQUIDITY_USD } from "../lib/constants";

export interface DefiLlamaCoinPrice {
  price: number;
  symbol: string;
  timestamp: number;
  confidence: number;
}

export interface PeggedAsset {
  id: string;
  name: string;
  symbol: string;
  address?: string;
  geckoId?: string;
  price?: number | null;
  [key: string]: unknown;
}

export function hasMissingPrice(a: PeggedAsset): boolean {
  return a.price == null || typeof a.price !== "number" || a.price === 0;
}

/** Guard against corrupted API prices that would break peg deviation calculations */
export function isReasonablePrice(price: number, pegType: string | undefined): boolean {
  if (!pegType) return price > 0 && price < 100_000;
  if (pegType.includes("USD") || pegType.includes("EUR") || pegType.includes("GBP") || pegType.includes("CHF") || pegType.includes("BRL")) {
    return price > 0.01 && price < 50;
  }
  if (pegType.includes("JPY")) return price > 0.001 && price < 0.05;
  if (pegType.includes("IDR")) return price > 0.00001 && price < 0.001;
  if (pegType.includes("SGD")) return price > 0.2 && price < 5;
  if (pegType.includes("TRY")) return price > 0.005 && price < 0.5;
  if (pegType.includes("AUD")) return price > 0.2 && price < 5;
  if (pegType.includes("RUB")) {
    return price > 0.005 && price < 50; // RUB ~$0.0127, lower bound allows for further weakening
  }
  if (pegType.includes("ZAR")) return price > 0.01 && price < 0.5;
  if (pegType.includes("GOLD")) return price > 100 && price < 100_000;
  if (pegType.includes("SILVER")) return price > 5 && price < 500;
  return price > 0 && price < 100_000;
}

/** Map DL stablecoins API chain names → DL coins API prefixes */
const CHAIN_PREFIX_MAP: Record<string, string> = {
  "Ethereum": "ethereum",
  "Arbitrum": "arbitrum",
  "Polygon": "polygon",
  "BSC": "bsc",
  "Base": "base",
  "Optimism": "optimism",
  "Avalanche": "avax",
};

/** Build the DL coins API identifier from an asset address */
function addressToCoinId(address: string): string {
  if (address.includes(":")) {
    return address; // already prefixed: "megaeth:0x...", "algorand:..."
  } else if (address.startsWith("0x")) {
    return `ethereum:${address}`;
  } else {
    return `solana:${address}`;
  }
}

interface DexScreenerPair {
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  priceUsd: string;
  liquidity: { usd: number };
  chainId: string;
}

/**
 * Enrich assets that are missing prices via a 4-pass pipeline:
 *   1. Contract addresses via DefiLlama coins API (with multi-chain fallback)
 *   2. CoinGecko IDs via DefiLlama proxy
 *   3. CoinGecko direct API
 *   4. DexScreener search API (best-effort fallback)
 */
export async function enrichMissingPrices(assets: PeggedAsset[]): Promise<void> {
  const totalMissing = assets.filter(hasMissingPrice).length;
  if (totalMissing === 0) return;

  let pass1Count = 0;
  let pass1bCount = 0;
  let pass2Count = 0;
  let pass3Count = 0;
  let pass4Count = 0;

  try {
    // ── Pass 1: Contract addresses via DefiLlama coins API ──
    const withAddress: { index: number; coinId: string }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (!hasMissingPrice(a) || !a.address) continue;
      withAddress.push({ index: i, coinId: addressToCoinId(a.address) });
    }

    if (withAddress.length > 0) {
      const coinIds = withAddress.map((m) => m.coinId).join(",");
      const res = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
      if (res.ok) {
        const data = (await res.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
        for (const m of withAddress) {
          const priceInfo = data.coins[m.coinId];
          if (priceInfo?.price != null && priceInfo.price > 0) {
            assets[m.index].price = priceInfo.price;
            pass1Count++;
          }
        }
      }
    }

    // ── Pass 1b: Multi-chain fallback for 0x addresses still missing ──
    const stillMissingAddr = withAddress.filter(
      (m) => hasMissingPrice(assets[m.index]) && m.coinId.startsWith("ethereum:")
    );
    if (stillMissingAddr.length > 0) {
      // Build alternate chain coinIds from the asset's chains field
      const altLookups: { index: number; coinId: string }[] = [];
      for (const m of stillMissingAddr) {
        const a = assets[m.index];
        const chains = a.chains as string[] | undefined;
        if (!chains || !a.address) continue;
        const addr = a.address;
        for (const chain of chains) {
          if (chain === "Ethereum") continue; // already tried
          const prefix = CHAIN_PREFIX_MAP[chain];
          if (prefix) {
            altLookups.push({ index: m.index, coinId: `${prefix}:${addr}` });
          }
        }
      }

      if (altLookups.length > 0) {
        const coinIds = altLookups.map((m) => m.coinId).join(",");
        const res = await fetch(`${DEFILLAMA_COINS}/prices/current/${coinIds}`);
        if (res.ok) {
          const data = (await res.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
          const resolved = new Set<number>(); // avoid double-count
          for (const m of altLookups) {
            if (resolved.has(m.index)) continue;
            const priceInfo = data.coins[m.coinId];
            if (priceInfo?.price != null && priceInfo.price > 0) {
              assets[m.index].price = priceInfo.price;
              pass1bCount++;
              resolved.add(m.index);
            }
          }
        }
      }
    }

    // ── Pass 2: CoinGecko IDs via DefiLlama proxy ──
    const geckoPass: { index: number; geckoId: string }[] = [];
    const wrongGeckoPass: { index: number; geckoId: string }[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      if (!hasMissingPrice(a)) continue;
      const geckoId = a.geckoId as string | undefined;
      if (!geckoId) continue;
      if (geckoId.includes("wrong")) {
        // Strip "wrong" suffix to get the real geckoId for Pass 3
        const cleanId = geckoId.replace(/-?wrong-?/g, "").replace(/-$/, "");
        if (cleanId) wrongGeckoPass.push({ index: i, geckoId: cleanId });
      } else {
        geckoPass.push({ index: i, geckoId });
      }
    }

    const afterPass2: { index: number; geckoId: string }[] = [];
    if (geckoPass.length > 0) {
      const geckoIds = geckoPass.map((m) => `coingecko:${m.geckoId}`).join(",");
      const geckoRes = await fetch(`${DEFILLAMA_COINS}/prices/current/${geckoIds}`);
      if (geckoRes.ok) {
        const geckoData = (await geckoRes.json()) as { coins: Record<string, DefiLlamaCoinPrice> };
        for (const m of geckoPass) {
          const priceInfo = geckoData.coins[`coingecko:${m.geckoId}`];
          if (priceInfo?.price != null && priceInfo.price > 0) {
            assets[m.index].price = priceInfo.price;
            pass2Count++;
          } else {
            afterPass2.push(m);
          }
        }
      } else {
        afterPass2.push(...geckoPass);
      }
    }
    // "wrong" geckoIds skip Pass 2 but go straight to Pass 3
    afterPass2.push(...wrongGeckoPass);

    // ── Pass 3: CoinGecko direct API ──
    if (afterPass2.length > 0) {
      const ids = afterPass2.map((m) => m.geckoId).join(",");
      const cgRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
        { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } }
      );
      if (cgRes.ok) {
        const cgData = (await cgRes.json()) as Record<string, { usd?: number }>;
        for (const m of afterPass2) {
          if (cgData[m.geckoId]?.usd != null) {
            assets[m.index].price = cgData[m.geckoId].usd!;
            pass3Count++;
          }
        }
      } else {
        console.warn(`[enrich] CoinGecko API returned ${cgRes.status}`);
      }
    }

    // ── Pass 4: DexScreener search API (best-effort fallback) ──
    const stillMissing = assets
      .map((a, i) => ({ asset: a, index: i }))
      .filter((m) => hasMissingPrice(m.asset));

    for (const m of stillMissing) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(m.asset.symbol)}`,
          { headers: { "User-Agent": USER_AGENT } }
        );
        if (!res.ok) {
          console.warn(`[enrich] DexScreener returned ${res.status} for ${m.asset.symbol}`);
          continue;
        }
        const data = (await res.json()) as { pairs?: DexScreenerPair[] };
        if (!data.pairs || data.pairs.length === 0) continue;

        // Filter: matching symbol, has USD price, >$50K liquidity
        const candidates = data.pairs.filter((p) => {
          if (p.baseToken.symbol.toUpperCase() !== m.asset.symbol.toUpperCase()) return false;
          if (!p.priceUsd || !p.liquidity?.usd) return false;
          if (p.liquidity.usd < DEXSCREENER_MIN_LIQUIDITY_USD) return false;
          return true;
        });

        if (candidates.length === 0) continue;

        // Take price from highest-liquidity pair
        candidates.sort((a, b) => b.liquidity.usd - a.liquidity.usd);
        const price = parseFloat(candidates[0].priceUsd);
        // Sanity check: peg-type-aware range
        const isGold = (m.asset.pegType as string | undefined)?.includes("GOLD");
        const maxPrice = isGold ? 100_000 : 1000;
        if (!isNaN(price) && price > 0.01 && price < maxPrice) {
          assets[m.index].price = price;
          pass4Count++;
        }
      } catch (err) {
        console.warn(`[enrich] DexScreener failed for ${m.asset.symbol}:`, err);
      }
    }

    // ── Summary log ──
    const finalMissing = assets.filter(hasMissingPrice).length;
    const totalEnriched = pass1Count + pass1bCount + pass2Count + pass3Count + pass4Count;
    if (totalMissing > 0) {
      console.log(
        `[enrich] ${totalMissing} assets missing prices → ` +
        `Pass 1: +${pass1Count}, Pass 1b (multi-chain): +${pass1bCount}, ` +
        `Pass 2: +${pass2Count}, Pass 3: +${pass3Count}, ` +
        `Pass 4 (DexScreener): +${pass4Count}, still missing: ${finalMissing}`
      );
    }
    if (totalEnriched > 0) {
      console.log(`[sync-stablecoins] Enriched prices for ${totalEnriched} assets`);
    }
  } catch (err) {
    console.warn("[sync-stablecoins] Price enrichment failed:", err);
  }
}
