import { throwIfAborted } from "../../lib/abort";
import type { AdapterContext } from "./types";
import { fetchJsonWithRetry } from "./request";

/**
 * DFINITY's ICRC ledger REST index. Verified 2026-07-29 to agree to the unit
 * with a direct `ic0.app` replica query (CBOR envelope, Candid `nat`), which is
 * the reason this reader can stay a dependency-free JSON GET instead of
 * hand-rolling CBOR inside the Worker.
 */
const ICRC_LEDGER_API_BASE_URLS = ["https://icrc-api.internetcomputer.org/api/v1/ledgers"] as const;

/** Text-form principals are base32-with-CRC groups; nothing else may reach the URL. */
const ICP_CANISTER_ID_RE = /^[a-z2-7]+(-[a-z2-7]+)*$/;

interface IcrcLedgerResponse {
  icrc1_metadata?: {
    icrc1_total_supply?: unknown;
  };
}

/**
 * Read an ICRC-1 ledger's `icrc1_total_supply` in base units. Bases are tried in
 * order and the last error is rethrown when every one fails, so a curated
 * aggregate leg fails closed with a diagnosable reason.
 */
export async function fetchIcrcLedgerTotalSupply(options: {
  canisterId: string;
  signal: AbortSignal;
  ctx?: AdapterContext;
  apiBaseUrl?: string;
  fallbackApiBaseUrl?: string;
  timeoutMs?: number;
}): Promise<bigint | null> {
  if (!ICP_CANISTER_ID_RE.test(options.canisterId)) {
    throw new Error(`icrc1_total_supply probe requires a text-form canister id (${options.canisterId})`);
  }

  const baseUrls = [options.apiBaseUrl, options.fallbackApiBaseUrl, ...ICRC_LEDGER_API_BASE_URLS].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  let lastError: unknown = null;

  for (const baseUrl of baseUrls) {
    throwIfAborted(options.signal);
    try {
      const body = await fetchJsonWithRetry<IcrcLedgerResponse>(
        `${baseUrl.replace(/\/+$/, "")}/${options.canisterId}`,
        options.signal,
        options.timeoutMs ?? 10_000,
        options.ctx,
      );

      const totalSupply = body.icrc1_metadata?.icrc1_total_supply;
      if (typeof totalSupply !== "string" || !/^\d+$/.test(totalSupply)) {
        lastError = new Error(`icrc1_total_supply missing for ${options.canisterId} on ${baseUrl}`);
        continue;
      }
      return BigInt(totalSupply);
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  if (lastError) throw lastError;
  return null;
}
