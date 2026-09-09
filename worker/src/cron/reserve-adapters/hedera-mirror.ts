import { z } from "zod";
import { fetchJsonPostWithRetry, fetchJsonWithRetry } from "./request";
import type { AdapterContext } from "./types";

/**
 * Bounded read helpers for the public Hedera mirror node REST API
 * (https://mainnet-public.mirrornode.hedera.com/api/v1).
 *
 * Hedera has no Multicall3: every contract read is a single
 * `POST /contracts/call` simulation, optionally pinned to an explicit
 * block number. All callers in this adapter family first pin the latest
 * record-stream block via `fetchHederaLatestBlock()` and then execute every
 * contract call against that same hex block number, so collateral, debt and
 * gate reads form one same-block census. Every helper makes exactly one HTTP
 * request — no pagination ever runs inside an adapter attempt.
 */

const HederaBlockSchema = z.object({
  blocks: z.array(
    z.object({
      number: z.number().int().nonnegative(),
      timestamp: z.object({ from: z.string() }),
    }),
  ).min(1),
});

const HederaContractCallResponseSchema = z.object({
  result: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export interface HederaPinnedBlock {
  /** Record-stream block number (equals the EVM block number on Hedera). */
  number: number;
  /** Consensus timestamp seconds of the block's first record. */
  timestampSec: number;
  /** Consensus timestamp ISO string of the block's first record. */
  fromIso: string;
}

function parseHederaConsensusTimestamp(value: string, label: string): { sec: number; iso: string } {
  const [whole, fraction = "0"] = value.split(".");
  const sec = Number(whole);
  if (!Number.isSafeInteger(sec) || sec <= 0 || !/^\d+$/.test(whole) || !/^\d+$/.test(fraction)) {
    throw new Error(`hedera-mirror: ${label} is not a valid consensus timestamp: ${value.slice(0, 32)}`);
  }
  return { sec, iso: value };
}

/** Hex string of a block number, the format `contracts/call` accepts for pinning. */
export function hederaBlockParam(number: number): string {
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`hedera-mirror: block number is not a non-negative safe integer: ${number}`);
  }
  return `0x${number.toString(16)}`;
}

/**
 * Pins the latest record-stream block as the snapshot checkpoint. The response
 * carries both the block number (used to pin contract calls) and the block's
 * consensus timestamp (the snapshot's freshness anchor).
 */
export async function fetchHederaLatestBlock(
  baseUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  timeoutMs = 12_000,
): Promise<HederaPinnedBlock> {
  const url = `${baseUrl.replace(/\/+$/, "")}/blocks?limit=1&order=desc`;
  const payload = await fetchJsonWithRetry<unknown>(url, signal, timeoutMs, ctx);
  const parsed = HederaBlockSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("hedera-mirror: latest block response failed schema validation");
  }
  const block = parsed.data.blocks[0]!;
  const { sec, iso } = parseHederaConsensusTimestamp(block.timestamp.from, `block ${block.number} timestamp`);
  return { number: block.number, timestampSec: sec, fromIso: iso };
}

/**
 * One contract view call, executed at a pinned block number. Returns the raw
 * ABI-encoded hex result (`0x…`); reverts surface as a mirror-node error or an
 * empty result and are rejected rather than silently decoded.
 */
export async function callHederaContractAtBlock(
  baseUrl: string,
  options: {
    to: string;
    data: string;
    blockNumber: number;
    /** Value in tinybar for payable calls; contract views always use 0. */
    value?: number;
  },
  signal: AbortSignal,
  ctx?: AdapterContext,
  timeoutMs = 12_000,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, "")}/contracts/call`;
  const payload = await fetchJsonPostWithRetry<unknown>(
    url,
    {
      block: hederaBlockParam(options.blockNumber),
      data: options.data,
      estimate: false,
      from: "0x0000000000000000000000000000000000000000",
      gas: 15_000_000,
      gasPrice: 0,
      to: options.to,
      value: options.value ?? 0,
    },
    signal,
    timeoutMs,
    ctx,
  );
  const parsed = HederaContractCallResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `hedera-mirror: contract call to ${options.to.slice(0, 14)}… (${options.data.slice(0, 10)}) at block ${options.blockNumber} returned no result hex`,
    );
  }
  return parsed.data.result;
}
