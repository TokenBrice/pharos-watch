import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { JupiterPriceResponseSchema, SolanaSlotResponseSchema } from "../../lib/schemas";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { getCircuitRecord, shouldAttemptFetch, recordOutcomeSafe } from "../../lib/circuit-breaker";
import {
  endpointLabel,
  readResponseSnippet,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import {
  applyResolvedPrice,
  hasMissingPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import {
  type EnrichPassResult,
  SOLANA_MINT_BY_ID,
} from "./enrich-prices-pass-common";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_MAX_IDS_PER_REQUEST = 50;
const JUPITER_REQUEST_TIMEOUT_MS = 5_000;
const JUPITER_MAX_RETRIES = 0;
const JUPITER_MIN_LIQUIDITY_USD = 50_000;
const JUPITER_MAX_SLOT_LAG = 2_250;
const JUPITER_MAX_SLOT_LEAD = 250;
const JUPITER_PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];
const SOLANA_SLOT_RPC_URL = "https://api.mainnet-beta.solana.com";
const SOLANA_SLOT_REQUEST_TIMEOUT_MS = 3_000;

interface JupiterPriceEntry {
  usdPrice?: number | null;
  blockId?: number;
  decimals: number;
  priceChange24h?: number | null;
  liquidity?: number | null;
  createdAt?: string | number;
}

export async function runJupiterPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
  jupiterApiKey?: string | null,
): Promise<EnrichPassResult> {
  let resolved = 0;
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];
  const candidates = assets.flatMap((asset, index) => {
    const mint = SOLANA_MINT_BY_ID.get(asset.id);
    return hasMissingPrice(asset) && mint ? [{ asset, index, mint }] : [];
  });
  if (candidates.length === 0) {
    if (db) {
      const record = await getCircuitRecord(db, CIRCUIT_SOURCE.JUPITER_PRICES);
      if (record.state !== "closed") {
        diagnostics.push({
          source: "jupiter",
          stage: "no-candidates",
          endpoint: "none",
          status: null,
          ok: true,
          success: true,
          candidateCount: 0,
        });
        await recordOutcomeSafe(db, CIRCUIT_SOURCE.JUPITER_PRICES, true);
      }
    }
    return { resolved, failures: [], diagnostics };
  }

  const jupiterAllowed = db != null ? await shouldAttemptFetch(db, CIRCUIT_SOURCE.JUPITER_PRICES) : true;
  if (!jupiterAllowed) {
    console.warn("[enrich] Jupiter circuit open — skipping pass 3");
    return { resolved, failures: [], diagnostics };
  }

  let successfulCalls = 0;
  let currentSolanaSlot: number | null | undefined;
  const getCurrentSolanaSlot = async (): Promise<number | null> => {
    if (currentSolanaSlot !== undefined) return currentSolanaSlot;
    const result = await fetchSolanaCurrentSlot(signal);
    currentSolanaSlot = result.slot;
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
    }
    return currentSolanaSlot;
  };

  for (let index = 0; index < candidates.length; index += JUPITER_MAX_IDS_PER_REQUEST) {
    const batch = candidates.slice(index, index + JUPITER_MAX_IDS_PER_REQUEST);
    const ids = batch.map((entry) => entry.mint);

    const { data, diagnostic } = await fetchJupiterPrices(ids, "fallback", signal, jupiterApiKey);
    diagnostics.push(diagnostic);
    if (!diagnostic.success || !data) {
      console.warn(`[enrich] Jupiter returned ${diagnostic.status ?? "no response"} for batch of ${ids.length}`);
      continue;
    }

    successfulCalls += 1;
    const batchHasUsableQuoteShape = batch.some((entry) => {
      const payload = data[entry.mint];
      return (
        payload?.usdPrice != null
        && Number.isFinite(payload.usdPrice)
        && payload.usdPrice > 0
        && typeof payload.blockId === "number"
      );
    });
    if (!batchHasUsableQuoteShape) continue;

    const currentSlot = await getCurrentSolanaSlot();
    if (currentSlot == null) {
      console.warn("[enrich] Jupiter block freshness check skipped because Solana slot reference is unavailable");
      continue;
    }
    for (const entry of batch) {
      const payload = data[entry.mint];
      const usdPrice = payload?.usdPrice;
      const blockId = payload?.blockId;
      const liquidity = payload?.liquidity;
      if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) continue;
      if (blockId == null || !isFreshJupiterBlock(blockId, currentSlot)) continue;
      if (liquidity != null && (!Number.isFinite(liquidity) || liquidity < JUPITER_MIN_LIQUIDITY_USD)) continue;

      if (!isReasonablePrice(
        usdPrice,
        entry.asset.pegType as string | undefined,
        fxRates,
        buildPriceReasonablenessOptions(entry.asset),
      )) {
        continue;
      }

      applyResolvedPrice(assets[entry.index], usdPrice, "jupiter", "fallback");
      resolved += 1;
    }
  }

  if (db) {
    await recordOutcomeSafe(db, CIRCUIT_SOURCE.JUPITER_PRICES, successfulCalls > 0);
  }

  return { resolved, failures: [], diagnostics };
}

async function fetchJupiterPrices(
  ids: string[],
  stage: PricingProviderAttemptDiagnostic["stage"],
  signal?: AbortSignal,
  jupiterApiKey?: string | null,
): Promise<{
  data: Record<string, JupiterPriceEntry> | null;
  diagnostic: PricingProviderAttemptDiagnostic;
}> {
  const url = `${JUPITER_PRICE_API}?ids=${encodeURIComponent(ids.join(","))}`;
  const endpoint = endpointLabel(url);
  const baseDiagnostic = {
    source: "jupiter" as const,
    stage,
    endpoint,
    status: null,
    ok: false,
    success: false,
    candidateCount: ids.length,
  };

  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      signal,
    },
    JUPITER_MAX_RETRIES,
    {
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS,
      passthroughStatuses: JUPITER_PASSTHROUGH_STATUSES,
    },
  );
  if (!res) {
    return {
      data: null,
      diagnostic: { ...baseDiagnostic, errorClass: "no-response" },
    };
  }

  const diagnostic: PricingProviderAttemptDiagnostic = {
    ...baseDiagnostic,
    status: res.status,
    ok: res.ok,
    success: false,
  };

  if (!res.ok) {
    diagnostic.snippet = await readResponseSnippet(res);
    return { data: null, diagnostic };
  }

  try {
    const parsed = JupiterPriceResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      diagnostic.errorClass = "invalid-shape";
      diagnostic.errorMessage = "Expected Jupiter V3 price payload with usdPrice, decimals, and blockId";
      diagnostic.rejectionReasonCounts = { "invalid-shape": 1 };
      return { data: null, diagnostic };
    }
    const data = parsed.data as Record<string, JupiterPriceEntry>;
    diagnostic.responseRowCount = Object.keys(data).length;
    const missingQuoteRows = Object.values(data).filter((entry) => (
      entry.usdPrice == null || entry.blockId == null
    )).length;
    if (missingQuoteRows > 0) {
      diagnostic.rejectionReasonCounts = { "missing-quote": missingQuoteRows };
    }
    diagnostic.success = true;
    return { data, diagnostic };
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    diagnostic.errorClass = err instanceof Error && err.name ? err.name : typeof err;
    diagnostic.errorMessage = err instanceof Error ? err.message : String(err);
    return { data: null, diagnostic };
  }
}

function isFreshJupiterBlock(blockId: number, currentSlot: number): boolean {
  if (!Number.isFinite(blockId) || !Number.isFinite(currentSlot)) return false;
  if (blockId > currentSlot + JUPITER_MAX_SLOT_LEAD) return false;
  return currentSlot - blockId <= JUPITER_MAX_SLOT_LAG;
}

async function fetchSolanaCurrentSlot(signal?: AbortSignal): Promise<{
  slot: number | null;
  diagnostic?: PricingProviderAttemptDiagnostic;
}> {
  const endpoint = endpointLabel(SOLANA_SLOT_RPC_URL);
  const baseDiagnostic: PricingProviderAttemptDiagnostic = {
    source: "jupiter",
    stage: "fallback",
    endpoint,
    status: null,
    ok: false,
    success: false,
    candidateCount: 1,
  };

  const res = await fetchWithRetry(
    SOLANA_SLOT_RPC_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSlot",
      }),
      signal,
    },
    0,
    {
      timeoutMs: SOLANA_SLOT_REQUEST_TIMEOUT_MS,
      passthroughStatuses: JUPITER_PASSTHROUGH_STATUSES,
    },
  );

  if (!res) {
    return {
      slot: null,
      diagnostic: {
        ...baseDiagnostic,
        errorClass: "no-response",
        errorMessage: "Solana slot reference returned no response",
      },
    };
  }

  const diagnostic: PricingProviderAttemptDiagnostic = {
    ...baseDiagnostic,
    status: res.status,
    ok: res.ok,
  };

  if (!res.ok) {
    diagnostic.snippet = await readResponseSnippet(res);
    diagnostic.errorClass = "upstream-error";
    diagnostic.errorMessage = "Solana slot reference returned non-OK";
    return { slot: null, diagnostic };
  }

  try {
    const parsed = SolanaSlotResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      diagnostic.errorClass = "invalid-shape";
      diagnostic.errorMessage = "Expected Solana getSlot JSON-RPC result";
      diagnostic.rejectionReasonCounts = { "invalid-shape": 1 };
      return { slot: null, diagnostic };
    }
    return { slot: parsed.data.result };
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    diagnostic.errorClass = err instanceof Error && err.name ? err.name : typeof err;
    diagnostic.errorMessage = err instanceof Error ? err.message : String(err);
    diagnostic.rejectionReasonCounts = { "malformed-json": 1 };
    return { slot: null, diagnostic };
  }
}
