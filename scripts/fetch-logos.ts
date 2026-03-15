/**
 * Fetches stablecoin logos from CoinGecko and writes logos.json.
 * Run locally: tsx scripts/fetch-logos.ts
 * CoinGecko blocks Cloudflare Workers, so this must run from a local machine.
 */

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const DEFILLAMA_BASE = "https://stablecoins.llama.fi";

const EXTRA_GECKO_IDS: Record<string, string> = {
  "tether-gold": "xaut-tether",
  "pax-gold": "paxg-paxos",
};

interface DefiLlamaAsset {
  id: string;
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

  const llamaData = (await llamaRes.json()) as { peggedAssets: DefiLlamaAsset[] };
  const assets = llamaData.peggedAssets ?? [];

  // Build gecko_id -> llama_id mapping
  const geckoToLlama: Record<string, string> = {};
  for (const a of assets) {
    if (a.gecko_id) {
      geckoToLlama[a.gecko_id] = a.id;
    }
  }
  for (const [geckoId, internalId] of Object.entries(EXTRA_GECKO_IDS)) {
    geckoToLlama[geckoId] = internalId;
  }

  const geckoIds = Object.keys(geckoToLlama);
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
        const llamaId = geckoToLlama[coin.id];
        if (llamaId && coin.image) {
          logoMap[llamaId] = coin.image.replace("/large/", "/small/");
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
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "logos.json");

  let existing: Record<string, string> = {};
  try {
    existing = JSON.parse(fs.readFileSync(outPath, "utf-8"));
  } catch {
    // file doesn't exist yet — start fresh
  }
  for (const [id, url] of Object.entries(existing)) {
    if (url.startsWith("/logos/") && !(id in logoMap)) {
      logoMap[id] = url;
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(logoMap, null, 2));
  console.log(`Wrote ${Object.keys(logoMap).length} logos to ${outPath}`);
}

fetchLogos();
