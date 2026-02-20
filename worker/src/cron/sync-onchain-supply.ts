import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { getChainRpc } from "../lib/chain-rpcs";
import { upsertOnchainSupply } from "../lib/db";
import { bigIntToDecimal } from "../lib/bigint";
import { TRON_BURN_ADDRESS, USER_AGENT } from "../lib/constants";
import type { ContractDeployment } from "../../../src/lib/types";

interface ContractQuery {
  stablecoinId: string;
  contract: ContractDeployment;
}

/** Run a JSON-RPC batch and parse totalSupply results into the map */
async function runEvmBatch(
  rpcUrl: string,
  queries: ContractQuery[],
  results: Map<string, number>
): Promise<ContractQuery[]> {
  const selector = "0x18160ddd"; // totalSupply()
  const failed: ContractQuery[] = [];

  const batchBody = queries.map((q, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: q.contract.address, data: selector }, "latest"],
  }));

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(batchBody),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[onchain-supply] RPC batch failed for ${rpcUrl}: ${res.status}`);
      return queries; // all failed
    }

    const responses = (await res.json()) as { id: number; result?: string; error?: unknown }[];

    const seen = new Set<number>();
    for (const resp of responses) {
      seen.add(resp.id);
      const query = queries[resp.id];
      if (!query) continue;
      if (!resp.result || resp.result === "0x" || resp.error) {
        failed.push(query);
        continue;
      }

      try {
        const supply = bigIntToDecimal(BigInt(resp.result), query.contract.decimals);
        if (supply > 0) {
          const key = `${query.stablecoinId}:${query.contract.chain}`;
          results.set(key, supply);
        }
      } catch {
        console.warn(`[onchain-supply] Failed to parse supply for ${query.stablecoinId} on ${query.contract.chain}`);
        failed.push(query);
      }
    }

    // Detect queries that received no response at all (RPC dropped them)
    for (let i = 0; i < queries.length; i++) {
      if (!seen.has(i)) failed.push(queries[i]);
    }
  } catch (err) {
    console.error(`[onchain-supply] RPC request failed for ${rpcUrl}:`, err);
    return queries; // all failed
  }

  return failed;
}

/** Batch size for keyed RPC providers (Alchemy — no batch limit) */
const BATCH_CHUNK_KEYED = 50;
/** Batch size for public RPCs (conservative — many enforce 25-request limits) */
const BATCH_CHUNK_PUBLIC = 20;

/** Fetch totalSupply for a batch of EVM contracts, with optional fallback RPC */
async function fetchEvmTotalSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  fallbackRpcUrl?: string,
  keyedPrimary?: boolean
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const primaryChunk = keyedPrimary ? BATCH_CHUNK_KEYED : BATCH_CHUNK_PUBLIC;

  // Chunk primary RPC requests to stay under batch size limits
  let allFailed: ContractQuery[] = [];
  for (let i = 0; i < queries.length; i += primaryChunk) {
    const chunk = queries.slice(i, i + primaryChunk);
    const failed = await runEvmBatch(rpcUrl, chunk, results);
    allFailed.push(...failed);
  }

  if (allFailed.length > 0 && fallbackRpcUrl) {
    console.log(`[onchain-supply] Retrying ${allFailed.length} failed queries on fallback RPC`);
    for (let i = 0; i < allFailed.length; i += BATCH_CHUNK_PUBLIC) {
      const chunk = allFailed.slice(i, i + BATCH_CHUNK_PUBLIC);
      await runEvmBatch(fallbackRpcUrl, chunk, results);
    }
  }

  return results;
}

/** Fetch totalSupply for Tron contracts via triggerConstantContract */
async function fetchTronTotalSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  apiKey: string | null
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  for (const query of queries) {
    try {
      const res = await fetch(`${rpcUrl}/wallet/triggerConstantContract`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          owner_address: TRON_BURN_ADDRESS,
          contract_address: query.contract.address,
          function_selector: "totalSupply()",
          parameter: "",
          visible: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;

      const data = (await res.json()) as { constant_result?: string[] };
      const hex = data.constant_result?.[0];
      if (!hex) continue;

      const supply = bigIntToDecimal(BigInt("0x" + hex), query.contract.decimals);
      if (supply > 0) {
        const key = `${query.stablecoinId}:${query.contract.chain}`;
        results.set(key, supply);
      }
    } catch {
      console.warn(`[onchain-supply] Tron query failed for ${query.stablecoinId}`);
    }
  }

  return results;
}

export async function syncOnchainSupply(db: D1Database, tronApiKey: string | null): Promise<void> {
  const allQueries: ContractQuery[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    for (const contract of meta.contracts) {
      allQueries.push({ stablecoinId: meta.id, contract });
    }
  }

  if (allQueries.length === 0) {
    console.log("[onchain-supply] No contracts configured, skipping");
    return;
  }

  // Group by chain
  const byChain = new Map<string, ContractQuery[]>();
  for (const q of allQueries) {
    const list = byChain.get(q.contract.chain) ?? [];
    list.push(q);
    byChain.set(q.contract.chain, list);
  }

  // Query each chain in parallel
  const supplyMap = new Map<string, number>();
  const chainPromises: Promise<void>[] = [];

  for (const [chainId, queries] of byChain) {
    const rpc = getChainRpc(chainId);
    if (!rpc) {
      console.warn(`[onchain-supply] No RPC config for chain: ${chainId}`);
      continue;
    }

    chainPromises.push(
      (async () => {
        let results: Map<string, number>;
        if (rpc.type === "evm") {
          results = await fetchEvmTotalSupply(rpc.rpcUrl, queries, rpc.fallbackRpcUrl, rpc.alchemyPrimary);
        } else {
          results = await fetchTronTotalSupply(rpc.rpcUrl, queries, tronApiKey);
        }
        for (const [key, supply] of results) {
          supplyMap.set(key, supply);
        }
      })()
    );
  }

  await Promise.all(chainPromises);

  // Write results to D1
  const rows = Array.from(supplyMap.entries()).map(([key, supply]) => {
    const [stablecoinId, chain] = key.split(":");
    return { stablecoinId, chain, supply };
  });

  if (rows.length > 0) {
    await upsertOnchainSupply(db, rows);
    console.log(`[onchain-supply] Updated ${rows.length} supply entries across ${byChain.size} chains`);
  } else {
    console.warn("[onchain-supply] No supply data retrieved");
  }
}
