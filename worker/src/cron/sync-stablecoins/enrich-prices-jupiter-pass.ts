import { logWorkerEventArgs } from "../../lib/structured-log";
import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { pricesAgreeWithinBps } from "../../lib/price-divergence";
import { JupiterPriceResponseSchema, SolanaSlotResponseSchema } from "../../lib/schemas";
import { throwIfAborted } from "../../lib/abort";
import {
  applyJsonParseFailureDiagnostic,
  applyNonOkProviderDiagnostic,
  buildPricingProviderDiagnostic,
  isProviderCircuitAllowed,
  recoverProviderOnNoCandidates,
  recordProviderOutcomeSafe,
  responseFromBufferedBody,
} from "../../lib/pricing-provider-lifecycle";
import {
  endpointLabel,
  type PricingProviderAttemptDiagnostic,
} from "../../lib/pricing-provider-diagnostics";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import {
  applyResolvedPrice,
  type PeggedAsset,
} from "./enrich-prices-shared";
import { getCirculatingRaw } from "@shared/lib/supply";
import {
  collectMissingPriceCandidates,
  type EnrichPassResult,
  SOLANA_MINT_BY_ID,
} from "./enrich-prices-pass-common";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_MAX_IDS_PER_REQUEST = 50;
const JUPITER_REQUEST_TIMEOUT_MS = 5_000;
const JUPITER_MAX_RETRIES = 0;
const JUPITER_MIN_LIQUIDITY_USD = 50_000;
const JUPITER_MAX_PRIMARY_AUGMENTATION_TARGETS = 25;
const JUPITER_PRIMARY_AUGMENTATION_MAX_DIVERGENCE_BPS = 100;
const JUPITER_MAX_SLOT_LAG = 2_250;
const JUPITER_MAX_SLOT_LEAD = 250;
const JUPITER_PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];
const SOLANA_SLOT_RPC_URLS = [
  "https://api.mainnet-beta.solana.com",
  "https://api.mainnet.solana.com",
  "https://solana-rpc.publicnode.com",
] as const;
const SOLANA_SLOT_REQUEST_TIMEOUT_MS = 3_000;

interface JupiterPriceEntry {
  usdPrice?: number | null;
  blockId?: number;
  decimals: number;
  priceChange24h?: number | null;
  liquidity?: number | null;
  createdAt?: string | number;
}

interface JupiterCandidate {
  asset: PeggedAsset;
  index: number;
  mint: string;
  mode: "fallback" | "primary";
  priorityUsd: number;
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
  const fallbackCandidates: JupiterCandidate[] = collectMissingPriceCandidates(assets, (asset) => {
    const mint = SOLANA_MINT_BY_ID.get(asset.id);
    return mint ? { mint } : null;
  }).map((candidate) => ({
    ...candidate,
    mode: "fallback" as const,
    priorityUsd: getCirculatingRaw(candidate.asset),
  }));
  const primaryCandidates = collectPrimaryAugmentationCandidates(assets);
  const candidates = [...fallbackCandidates, ...primaryCandidates];
  if (candidates.length === 0) {
    await recoverProviderOnNoCandidates({
      db,
      circuitSource: CIRCUIT_SOURCE.JUPITER_PRICES,
      diagnostic: {
        source: "jupiter",
        stage: "no-candidates",
        endpoint: "none",
      },
      diagnostics,
    });
    return { resolved, failures: [], diagnostics };
  }

  const jupiterAllowed = await isProviderCircuitAllowed({
    db,
    circuitSource: CIRCUIT_SOURCE.JUPITER_PRICES,
    diagnostic: {
      source: "jupiter",
      stage: "fallback",
      endpoint: endpointLabel(JUPITER_PRICE_API),
      candidateCount: candidates.length,
    },
    errorMessage: "Jupiter circuit open",
  });
  if (!jupiterAllowed) {
    logWorkerEventArgs("handler", "warn", "[enrich] Jupiter circuit open — skipping pass 3");
    return { resolved, failures: [], diagnostics };
  }

  let successfulCalls = 0;
  let currentSolanaSlot: number | null | undefined;
  const getCurrentSolanaSlot = async (): Promise<number | null> => {
    if (currentSolanaSlot !== undefined) return currentSolanaSlot;
    const result = await fetchSolanaCurrentSlot(signal);
    currentSolanaSlot = result.slot;
    diagnostics.push(...result.diagnostics);
    return currentSolanaSlot;
  };

  for (let index = 0; index < candidates.length; index += JUPITER_MAX_IDS_PER_REQUEST) {
    throwIfAborted(signal);
    const batch = candidates.slice(index, index + JUPITER_MAX_IDS_PER_REQUEST);
    const ids = batch.map((entry) => entry.mint);

    const stage = batch.every((entry) => entry.mode === "primary") ? "primary" : "fallback";
    const { data, diagnostic } = await fetchJupiterPrices(ids, stage, signal, jupiterApiKey);
    diagnostics.push(diagnostic);
    if (!diagnostic.success || !data) {
      logWorkerEventArgs("handler", "warn", `[enrich] Jupiter returned ${diagnostic.status ?? "no response"} for batch of ${ids.length}`);
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
      logWorkerEventArgs("handler", "warn", "[enrich] Jupiter block freshness check skipped because Solana slot reference is unavailable");
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

      if (entry.mode === "fallback") {
        applyResolvedPrice(assets[entry.index], usdPrice, "jupiter", "fallback");
        resolved += 1;
      } else if (applyJupiterPrimaryAugmentation(assets[entry.index], usdPrice)) {
        resolved += 1;
      }
    }
  }

  if (db) {
    await recordProviderOutcomeSafe({
      db,
      circuitSource: CIRCUIT_SOURCE.JUPITER_PRICES,
      attempted: Math.ceil(candidates.length / JUPITER_MAX_IDS_PER_REQUEST),
      successful: successfulCalls,
      recordWhenNoAttempts: true,
    });
  }

  return { resolved, failures: [], diagnostics };
}

function collectPrimaryAugmentationCandidates(assets: PeggedAsset[]): JupiterCandidate[] {
  return assets
    .map((asset, index): JupiterCandidate | null => {
      const mint = SOLANA_MINT_BY_ID.get(asset.id);
      if (!mint || asset.price == null || typeof asset.price !== "number" || asset.price <= 0) {
        return null;
      }
      if (asset.consensusSources?.includes("jupiter")) return null;
      const sourceDepth = asset.consensusSources?.length ?? 0;
      const lowConfidence =
        asset.priceConfidence === "fallback" ||
        asset.priceConfidence === "low" ||
        asset.priceConfidence === "single-source";
      if (sourceDepth > 2 && !lowConfidence) return null;
      return {
        asset,
        index,
        mint,
        mode: "primary",
        priorityUsd: getCirculatingRaw(asset),
      };
    })
    .filter((entry): entry is JupiterCandidate => entry != null)
    .sort((left, right) => {
      const leftDepth = left.asset.consensusSources?.length ?? 0;
      const rightDepth = right.asset.consensusSources?.length ?? 0;
      if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      if (left.priorityUsd !== right.priorityUsd) return right.priorityUsd - left.priorityUsd;
      return left.asset.id.localeCompare(right.asset.id);
    })
    .slice(0, JUPITER_MAX_PRIMARY_AUGMENTATION_TARGETS);
}

function applyJupiterPrimaryAugmentation(asset: PeggedAsset, jupiterPrice: number): boolean {
  if (asset.price == null || typeof asset.price !== "number" || asset.price <= 0) return false;
  if (!pricesAgreeWithinBps(asset.price, jupiterPrice, JUPITER_PRIMARY_AUGMENTATION_MAX_DIVERGENCE_BPS)) {
    return false;
  }
  const consensusSources = asset.consensusSources ?? (asset.priceSource ? [asset.priceSource] : []);
  if (!consensusSources.includes("jupiter")) {
    asset.consensusSources = [...consensusSources, "jupiter"];
  }
  // Deliberately do not add Jupiter to agreeSources or replace priceSource here.
  // The pass only exposes a bounded soft corroborator for source-depth/UI use.
  return true;
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
    candidateCount: ids.length,
  };

  const result = await fetchTextWithRetry(
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
      returnFinalResponse: true,
    },
  );
  if (!result) {
    return {
      data: null,
      diagnostic: buildPricingProviderDiagnostic(baseDiagnostic, { errorClass: "no-response" }),
    };
  }

  const diagnostic: PricingProviderAttemptDiagnostic = buildPricingProviderDiagnostic(baseDiagnostic, {
    status: result.response.status,
    ok: result.response.ok,
  });

  if (!result.response.ok) {
    return { data: null, diagnostic: await applyNonOkProviderDiagnostic(diagnostic, responseFromBufferedBody(result)) };
  }

  try {
    const parsed = JupiterPriceResponseSchema.safeParse(JSON.parse(result.body));
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
    return { data: null, diagnostic: applyJsonParseFailureDiagnostic(diagnostic, err) };
  }
}

function isFreshJupiterBlock(blockId: number, currentSlot: number): boolean {
  if (!Number.isFinite(blockId) || !Number.isFinite(currentSlot)) return false;
  if (blockId > currentSlot + JUPITER_MAX_SLOT_LEAD) return false;
  return currentSlot - blockId <= JUPITER_MAX_SLOT_LAG;
}

async function fetchSolanaCurrentSlot(signal?: AbortSignal): Promise<{
  slot: number | null;
  diagnostics: PricingProviderAttemptDiagnostic[];
}> {
  const diagnostics: PricingProviderAttemptDiagnostic[] = [];

  for (const rpcUrl of SOLANA_SLOT_RPC_URLS) {
    throwIfAborted(signal);
    const baseDiagnostic = {
      source: "jupiter" as const,
      stage: "fallback" as const,
      endpoint: endpointLabel(rpcUrl),
      candidateCount: 1,
    };
    const result = await fetchTextWithRetry(
      rpcUrl,
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
        returnFinalResponse: true,
      },
    );

    if (!result) {
      diagnostics.push(buildPricingProviderDiagnostic(baseDiagnostic, {
        errorClass: "no-response",
        errorMessage: "Solana slot reference returned no response",
      }));
      continue;
    }

    const diagnostic: PricingProviderAttemptDiagnostic = buildPricingProviderDiagnostic(baseDiagnostic, {
      status: result.response.status,
      ok: result.response.ok,
    });

    if (!result.response.ok) {
      const nonOkDiagnostic = await applyNonOkProviderDiagnostic(diagnostic, responseFromBufferedBody(result));
      diagnostics.push({
        ...nonOkDiagnostic,
        errorClass: "upstream-error",
        errorMessage: "Solana slot reference returned non-OK",
      });
      continue;
    }

    try {
      const parsed = SolanaSlotResponseSchema.safeParse(JSON.parse(result.body));
      if (!parsed.success) {
        diagnostic.errorClass = "invalid-shape";
        diagnostic.errorMessage = "Expected Solana getSlot JSON-RPC result";
        diagnostic.rejectionReasonCounts = { "invalid-shape": 1 };
        diagnostics.push(diagnostic);
        continue;
      }
      return { slot: parsed.data.result, diagnostics };
    } catch (err) {
      diagnostics.push(applyJsonParseFailureDiagnostic(diagnostic, err));
    }
  }

  return { slot: null, diagnostics };
}
