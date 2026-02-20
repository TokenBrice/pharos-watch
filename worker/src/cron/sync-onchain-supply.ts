import { TRACKED_STABLECOINS, TRACKED_META_BY_ID } from "../../../src/lib/stablecoins";
import type { ContractDeployment } from "../../../src/lib/types";
import { getChainRpc } from "../lib/chain-rpcs";
import { upsertOnchainSupply } from "../lib/db";
import { bigIntToDecimal } from "../lib/bigint";
import { TRON_BURN_ADDRESS, USER_AGENT } from "../lib/constants";

interface ContractQuery {
  stablecoinId: string;
  contract: ContractDeployment;
}

/** A single RPC call within the batch */
interface RpcCall {
  /** Unique tag for correlating results */
  tag: string;
  to: string;
  data: string;
}

// --- Solidity function selectors ---
const SELECTOR_TOTAL_SUPPLY = "0x18160ddd";
const SELECTOR_BALANCE_OF = "0x70a08231";
const SELECTOR_DECIMALS = "0x313ce567";

/** Pad an Ethereum address to 32 bytes for balanceOf(address) call data */
function balanceOfCalldata(holderAddress: string): string {
  const addr = holderAddress.toLowerCase().replace("0x", "");
  return SELECTOR_BALANCE_OF + addr.padStart(64, "0");
}

/** Batch size for keyed RPC providers (Alchemy — no batch limit) */
const BATCH_CHUNK_KEYED = 50;
/** Batch size for public RPCs (conservative — many enforce 25-request limits) */
const BATCH_CHUNK_PUBLIC = 20;

/** Run a JSON-RPC batch and parse raw bigint results into the map */
async function runEvmBatch(
  rpcUrl: string,
  calls: RpcCall[],
  results: Map<string, bigint>
): Promise<RpcCall[]> {
  const failed: RpcCall[] = [];

  const batchBody = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [{ to: c.to, data: c.data }, "latest"],
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
      return calls; // all failed
    }

    const responses = (await res.json()) as { id: number; result?: string; error?: unknown }[];

    const seen = new Set<number>();
    for (const resp of responses) {
      seen.add(resp.id);
      const call = calls[resp.id];
      if (!call) continue;
      if (!resp.result || resp.result === "0x" || resp.error) {
        failed.push(call);
        continue;
      }

      try {
        results.set(call.tag, BigInt(resp.result));
      } catch {
        console.warn(`[onchain-supply] Failed to parse result for ${call.tag}`);
        failed.push(call);
      }
    }

    // Detect calls that received no response at all (RPC dropped them)
    for (let i = 0; i < calls.length; i++) {
      if (!seen.has(i)) failed.push(calls[i]);
    }
  } catch (err) {
    console.error(`[onchain-supply] RPC request failed for ${rpcUrl}:`, err);
    return calls; // all failed
  }

  return failed;
}

/** Fetch supply for a batch of EVM contracts, with optional fallback RPC */
async function fetchEvmSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  fallbackRpcUrl?: string,
  keyedPrimary?: boolean
): Promise<Map<string, number>> {
  const supplyResults = new Map<string, number>();

  // Build all RPC calls for this chain
  const allCalls: RpcCall[] = [];

  for (const q of queries) {
    const meta = TRACKED_META_BY_ID.get(q.stablecoinId);
    const method = meta?.supplyMethod;

    if (method?.type === "exclude") continue;

    if (method?.type === "custom-contract" && method.customContract?.chain === q.contract.chain) {
      // Custom contract call replaces totalSupply for this chain
      allCalls.push({
        tag: `custom:${q.stablecoinId}:${q.contract.chain}`,
        to: method.customContract.address,
        data: method.customContract.selector,
      });
    } else {
      // Standard totalSupply call
      allCalls.push({
        tag: `supply:${q.stablecoinId}:${q.contract.chain}`,
        to: q.contract.address,
        data: SELECTOR_TOTAL_SUPPLY,
      });
    }

    // Decimals verification call (always, for all contracts)
    allCalls.push({
      tag: `decimals:${q.stablecoinId}:${q.contract.chain}`,
      to: q.contract.address,
      data: SELECTOR_DECIMALS,
    });

    // balanceOf calls for subtract addresses matching this chain
    if (method?.type === "totalSupply-minus-addresses" && method.subtractAddresses) {
      for (const sub of method.subtractAddresses) {
        if (sub.chain === q.contract.chain) {
          allCalls.push({
            tag: `subtract:${q.stablecoinId}:${q.contract.chain}:${sub.address}`,
            to: q.contract.address,
            data: balanceOfCalldata(sub.address),
          });
        }
      }
    }
  }

  if (allCalls.length === 0) return supplyResults;

  // Execute batched calls with chunking
  const rawResults = new Map<string, bigint>();
  const primaryChunk = keyedPrimary ? BATCH_CHUNK_KEYED : BATCH_CHUNK_PUBLIC;

  let allFailed: RpcCall[] = [];
  for (let i = 0; i < allCalls.length; i += primaryChunk) {
    const chunk = allCalls.slice(i, i + primaryChunk);
    const failed = await runEvmBatch(rpcUrl, chunk, rawResults);
    allFailed.push(...failed);
  }

  if (allFailed.length > 0 && fallbackRpcUrl) {
    console.log(`[onchain-supply] Retrying ${allFailed.length} failed calls on fallback RPC`);
    for (let i = 0; i < allFailed.length; i += BATCH_CHUNK_PUBLIC) {
      const chunk = allFailed.slice(i, i + BATCH_CHUNK_PUBLIC);
      await runEvmBatch(fallbackRpcUrl, chunk, rawResults);
    }
  }

  // Process results: combine totalSupply, subtract balanceOf, verify decimals
  for (const q of queries) {
    const meta = TRACKED_META_BY_ID.get(q.stablecoinId);
    const method = meta?.supplyMethod;

    if (method?.type === "exclude") continue;

    // Decimals verification
    const decimalsRaw = rawResults.get(`decimals:${q.stablecoinId}:${q.contract.chain}`);
    if (decimalsRaw !== undefined) {
      const onchainDecimals = Number(decimalsRaw);
      if (onchainDecimals !== q.contract.decimals) {
        console.error(
          `[onchain-supply] DECIMAL MISMATCH: ${meta?.symbol ?? q.stablecoinId} on ${q.contract.chain} — ` +
          `configured=${q.contract.decimals} on-chain=${onchainDecimals}. Skipping.`
        );
        continue;
      }
    }

    const key = `${q.stablecoinId}:${q.contract.chain}`;

    if (method?.type === "custom-contract" && method.customContract?.chain === q.contract.chain) {
      // Custom contract result
      const customRaw = rawResults.get(`custom:${q.stablecoinId}:${q.contract.chain}`);
      if (customRaw !== undefined && customRaw > 0n) {
        supplyResults.set(key, bigIntToDecimal(customRaw, method.customContract!.decimals));
      }
    } else {
      // Standard totalSupply (with optional subtraction)
      const supplyRaw = rawResults.get(`supply:${q.stablecoinId}:${q.contract.chain}`);
      if (supplyRaw === undefined || supplyRaw <= 0n) continue;

      let netSupply = supplyRaw;

      if (method?.type === "totalSupply-minus-addresses" && method.subtractAddresses) {
        for (const sub of method.subtractAddresses) {
          if (sub.chain === q.contract.chain) {
            const balance = rawResults.get(`subtract:${q.stablecoinId}:${q.contract.chain}:${sub.address}`);
            if (balance !== undefined && balance > 0n) {
              netSupply -= balance;
            }
          }
        }

        if (netSupply <= 0n) {
          console.warn(`[onchain-supply] Net supply ${netSupply} for ${meta?.symbol ?? q.stablecoinId} on ${q.contract.chain} after subtraction, skipping`);
          continue;
        }
      }

      supplyResults.set(key, bigIntToDecimal(netSupply, q.contract.decimals));
    }
  }

  return supplyResults;
}

/** Make a single Tron triggerConstantContract call */
async function callTron(
  rpcUrl: string,
  contractAddress: string,
  functionSelector: string,
  parameter: string,
  apiKey?: string | null
): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": USER_AGENT };
    if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
    const res = await fetch(`${rpcUrl}/wallet/triggerconstantcontract`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        owner_address: TRON_BURN_ADDRESS,
        contract_address: contractAddress,
        function_selector: functionSelector,
        parameter,
        visible: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { constant_result?: string[] };
    return data.constant_result?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Fetch supply for a single Tron contract, returns true on success */
async function fetchSingleTronSupply(
  rpcUrl: string,
  query: ContractQuery,
  results: Map<string, number>,
  apiKey?: string | null
): Promise<boolean> {
  const meta = TRACKED_META_BY_ID.get(query.stablecoinId);
  const method = meta?.supplyMethod;

  if (method?.type === "exclude") return true; // intentionally skipped

  // Verify decimals
  const decimalsHex = await callTron(rpcUrl, query.contract.address, "decimals()", "", apiKey);
  if (decimalsHex) {
    const onchainDecimals = Number(BigInt("0x" + decimalsHex));
    if (onchainDecimals !== query.contract.decimals) {
      console.error(
        `[onchain-supply] DECIMAL MISMATCH (Tron): ${meta?.symbol ?? query.stablecoinId} — ` +
        `configured=${query.contract.decimals} on-chain=${onchainDecimals}. Skipping.`
      );
      return true; // mismatch is not a transient failure
    }
  }

  // Get totalSupply
  const supplyHex = await callTron(rpcUrl, query.contract.address, "totalSupply()", "", apiKey);
  if (!supplyHex) return false;

  let supplyRaw = BigInt("0x" + supplyHex);

  // Subtract addresses if configured for Tron
  // Note: Tron balanceOf requires base58→hex address conversion (not yet implemented).
  // No subtraction addresses are currently configured for Tron chains.

  if (supplyRaw > 0n) {
    const supply = bigIntToDecimal(supplyRaw, query.contract.decimals);
    results.set(`${query.stablecoinId}:${query.contract.chain}`, supply);
  }
  return true;
}

/** Fetch supply for Tron contracts with optional fallback RPC */
async function fetchTronSupply(
  rpcUrl: string,
  queries: ContractQuery[],
  fallbackRpcUrl?: string,
  tronApiKey?: string | null
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  const failed: ContractQuery[] = [];

  for (const query of queries) {
    const ok = await fetchSingleTronSupply(rpcUrl, query, results, tronApiKey);
    if (!ok) failed.push(query);
  }

  if (failed.length > 0 && fallbackRpcUrl) {
    console.log(`[onchain-supply] Retrying ${failed.length} failed Tron queries on fallback RPC`);
    for (const query of failed) {
      await fetchSingleTronSupply(fallbackRpcUrl, query, results, tronApiKey);
    }
  }

  return results;
}

export async function syncOnchainSupply(db: D1Database, tronApiKey?: string | null): Promise<void> {
  const allQueries: ContractQuery[] = [];
  for (const meta of TRACKED_STABLECOINS) {
    if (!meta.contracts) continue;
    if (meta.supplyMethod?.type === "exclude") continue;
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
        let chainResults: Map<string, number>;
        if (rpc.type === "evm") {
          chainResults = await fetchEvmSupply(rpc.rpcUrl, queries, rpc.fallbackRpcUrl, rpc.alchemyPrimary);
        } else {
          chainResults = await fetchTronSupply(rpc.rpcUrl, queries, rpc.fallbackRpcUrl, tronApiKey);
        }
        for (const [key, supply] of chainResults) {
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
