/**
 * Standalone backfill script — discovers DEX pools via CoinGecko Analyst-tier
 * megafilter endpoint for all tracked stablecoins with on-chain contracts.
 *
 * Usage:
 *   COINGECKO_API_KEY=... npx tsx worker/src/scripts/backfill-megafilter.ts > pools.json
 *
 * Outputs JSON array to stdout; progress/errors go to stderr.
 * Requires Node 18+ (native fetch).
 */

import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { CG_CHAIN_MAP } from "../lib/coingecko-onchain";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.COINGECKO_API_KEY;
if (!API_KEY) {
  console.error("ERROR: COINGECKO_API_KEY environment variable is required.");
  process.exit(1);
}

const BASE_URL = "https://pro-api.coingecko.com/api/v3";
const MAX_PAGES = 10; // 20 pools per page → up to 200 pools per token/network
const RATE_LIMIT_MS = 250;
const BACKOFF_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MegafilterPool {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    base_token_price_usd: string | null;
    quote_token_price_usd: string | null;
    reserve_in_usd: string | null;
    h24_volume_usd: string | null;
    pool_created_at: string | null;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex: { data: { id: string } };
  };
}

interface DiscoveredPool {
  stablecoinId: string;
  stablecoinName: string;
  chain: string;
  network: string;
  tokenAddress: string;
  poolId: string;
  poolAddress: string;
  poolName: string;
  dexId: string;
  baseTokenId: string;
  quoteTokenId: string;
  reserveUsd: number | null;
  volumeUsd24h: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let requestCount = 0;

async function megafilterFetch(
  tokenAddress: string,
  network: string,
  page: number,
): Promise<MegafilterPool[]> {
  const url = `${BASE_URL}/onchain/pools/megafilter?token_address=${tokenAddress}&networks=${network}&page=${page}&sort=h24_volume_usd_desc`;

  // Rate limit
  if (requestCount > 0) {
    await sleep(RATE_LIMIT_MS);
  }
  requestCount++;

  const res = await fetch(url, {
    headers: {
      "x-cg-pro-api-key": API_KEY!,
      Accept: "application/json",
    },
  });

  // Handle 429 with backoff retry
  if (res.status === 429) {
    console.error(`  [429] Rate limited — backing off ${BACKOFF_MS}ms...`);
    await sleep(BACKOFF_MS);
    requestCount++;
    const retry = await fetch(url, {
      headers: {
        "x-cg-pro-api-key": API_KEY!,
        Accept: "application/json",
      },
    });
    if (!retry.ok) {
      console.error(`  [${retry.status}] Retry failed for ${network}/${tokenAddress} page ${page}`);
      return [];
    }
    const json = (await retry.json()) as { data?: MegafilterPool[] };
    return json.data ?? [];
  }

  if (!res.ok) {
    console.error(`  [${res.status}] Failed for ${network}/${tokenAddress} page ${page}`);
    return [];
  }

  const json = (await res.json()) as { data?: MegafilterPool[] };
  return json.data ?? [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const allPools: DiscoveredPool[] = [];

  // Filter to stablecoins that have contracts
  const withContracts = TRACKED_STABLECOINS.filter(
    (s) => s.contracts && s.contracts.length > 0,
  );

  console.error(
    `Backfilling megafilter pools for ${withContracts.length} stablecoins with contracts...`,
  );

  for (const stablecoin of withContracts) {
    const contracts = stablecoin.contracts!;

    // Build list of (chain, network, address) tuples where CG has a mapping
    const targets = contracts
      .map((c) => ({
        chain: c.chain,
        network: CG_CHAIN_MAP[c.chain],
        address: c.address,
      }))
      .filter((t) => t.network !== undefined);

    if (targets.length === 0) continue;

    console.error(
      `\n[${stablecoin.symbol}] ${stablecoin.name} — ${targets.length} chain(s)`,
    );

    for (const { chain, network, address } of targets) {
      let totalForChain = 0;

      for (let page = 1; page <= MAX_PAGES; page++) {
        const pools = await megafilterFetch(address, network, page);

        if (pools.length === 0) break;

        for (const pool of pools) {
          const reserveStr = pool.attributes.reserve_in_usd;
          const volumeStr = pool.attributes.h24_volume_usd;

          allPools.push({
            stablecoinId: stablecoin.id,
            stablecoinName: stablecoin.name,
            chain,
            network,
            tokenAddress: address,
            poolId: pool.id,
            poolAddress: pool.attributes.address,
            poolName: pool.attributes.name,
            dexId: pool.relationships.dex.data.id,
            baseTokenId: pool.relationships.base_token.data.id,
            quoteTokenId: pool.relationships.quote_token.data.id,
            reserveUsd: reserveStr ? parseFloat(reserveStr) || null : null,
            volumeUsd24h: volumeStr ? parseFloat(volumeStr) || null : null,
          });
        }

        totalForChain += pools.length;

        // If we got fewer than 20, we've reached the last page
        if (pools.length < 20) break;
      }

      if (totalForChain > 0) {
        console.error(`  ${chain} (${network}): ${totalForChain} pools`);
      }
    }
  }

  console.error(`\nDone. Total pools discovered: ${allPools.length}`);

  // Output JSON to stdout
  process.stdout.write(JSON.stringify(allPools, null, 2) + "\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
