/**
 * Fetches stablecoin logos from CoinGecko and writes logos.json.
 * Run locally: tsx scripts/maintenance/fetch-logos.ts
 * CoinGecko blocks Cloudflare Workers, so this must run from a local machine.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import stablecoins from "@shared/data/stablecoins/coins.generated.json";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const DEFILLAMA_BASE = "https://stablecoins.llama.fi";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_OUTPUT_DIR = path.join(__dirname, "..", "..", "data");
const LOGO_OUTPUT_PATH = path.join(LOGO_OUTPUT_DIR, "logos.json");

const EXTRA_GECKO_IDS: Record<string, string> = {
  "tether-gold": "xaut-tether",
  "pax-gold": "paxg-paxos",
};

interface StablecoinLogoSeed {
  gecko_id?: string;
}

interface CoinGeckoMarket {
  id: string;
  image: string;
}

async function fetchLogos(): Promise<void> {
  // Fetch stablecoin list from DefiLlama
  console.log("Fetching stablecoin list from DefiLlama...");
  const llamaRes = await fetch(`${DEFILLAMA_BASE}/stablecoins?includePrices=true`);
  if (!llamaRes.ok) {
    console.error(`DefiLlama API error: ${llamaRes.status}`);
    process.exit(1);
  }

  const llamaData = (await llamaRes.json()) as { peggedAssets: StablecoinLogoSeed[] };
  const assets = llamaData.peggedAssets ?? [];

  const llamaGeckoIds = new Set(assets.flatMap((asset) => (asset.gecko_id ? [asset.gecko_id] : [])));

  // Build gecko_id -> canonical ticker-issuer id mapping.
  const geckoToCanonicalId: Record<string, string> = {};
  for (const coin of stablecoins) {
    if (coin.geckoId && llamaGeckoIds.has(coin.geckoId)) {
      geckoToCanonicalId[coin.geckoId] = coin.id;
    }
  }
  for (const [geckoId, canonicalId] of Object.entries(EXTRA_GECKO_IDS)) {
    geckoToCanonicalId[geckoId] = canonicalId;
  }

  const geckoIds = Object.keys(geckoToCanonicalId);
  console.log(`Found ${geckoIds.length} coins with gecko_id`);

  // Fetch logos from CoinGecko in batches
  const logoMap: Record<string, string> = {};
  const batchSize = 250;

  for (let i = 0; i < geckoIds.length; i += batchSize) {
    const batch = geckoIds.slice(i, i + batchSize);
    const ids = batch.join(",");
    console.log(`Fetching batch ${Math.floor(i / batchSize) + 1} (${batch.length} coins)...`);

    const res = await fetch(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&per_page=${batchSize}&page=1&sparkline=false`
    );

    if (res.ok) {
      const coins: CoinGeckoMarket[] = await res.json();
      for (const coin of coins) {
        const canonicalId = geckoToCanonicalId[coin.id];
        if (canonicalId && coin.image) {
          logoMap[canonicalId] = coin.image.replace("/large/", "/small/");
        }
      }
    } else {
      console.error(`CoinGecko API error: ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(body.slice(0, 200));
      process.exit(1);
    }

    // Rate limit: wait between batches
    if (i + batchSize < geckoIds.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Write to data/logos.json — preserve manually-placed local entries (those
  // pointing to /logos/... paths) so downloaded images survive script reruns.
  fs.mkdirSync(LOGO_OUTPUT_DIR, { recursive: true });

  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(fs.readFileSync(LOGO_OUTPUT_PATH, "utf-8"));
  } catch {
    // file doesn't exist yet — start fresh
  }
  for (const [id, url] of Object.entries(existing)) {
    if (!/^\d+$/.test(id) && url.startsWith("/logos/") && !(id in logoMap)) {
      logoMap[id] = url;
    }
  }

  fs.writeFileSync(LOGO_OUTPUT_PATH, JSON.stringify(logoMap, null, 2));
  console.log(`Wrote ${Object.keys(logoMap).length} logos to ${LOGO_OUTPUT_PATH}`);
}

fetchLogos();
