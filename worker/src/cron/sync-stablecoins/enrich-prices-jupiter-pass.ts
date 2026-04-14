import {
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../../lib/constants";
import { fetchWithRetry } from "../../lib/fetch-retry";
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

const JUPITER_PRICE_API = "https://lite-api.jup.ag/price/v3";
const JUPITER_CANARY_ID = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";
const JUPITER_MAX_IDS_PER_REQUEST = 50;
const JUPITER_REQUEST_TIMEOUT_MS = 5_000;
const JUPITER_MAX_RETRIES = 0;
const JUPITER_MIN_LIQUIDITY_USD = 50_000;
const JUPITER_PASSTHROUGH_STATUSES = [400, 401, 403, 404, 408, 409, 418, 425, 429, 451, 500, 502, 503, 504];

interface JupiterPriceEntry {
  usdPrice?: number;
  liquidity?: number;
  createdAt?: string | number;
}

export async function runJupiterPass(
  assets: PeggedAsset[],
  fxRates: Record<string, number> | undefined,
  db: D1Database | undefined,
  signal?: AbortSignal,
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
        const jupiterAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.JUPITER_PRICES);
        if (jupiterAllowed) {
          const { diagnostic } = await fetchJupiterPrices([JUPITER_CANARY_ID], "health-probe", signal);
          diagnostics.push(diagnostic);
          await recordOutcomeSafe(db, CIRCUIT_SOURCE.JUPITER_PRICES, diagnostic.success);
        }
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
  for (let index = 0; index < candidates.length; index += JUPITER_MAX_IDS_PER_REQUEST) {
    const batch = candidates.slice(index, index + JUPITER_MAX_IDS_PER_REQUEST);
    const ids = batch.map((entry) => entry.mint);

    const { data, diagnostic } = await fetchJupiterPrices(ids, "fallback", signal);
    diagnostics.push(diagnostic);
    if (!diagnostic.success || !data) {
      console.warn(`[enrich] Jupiter returned ${diagnostic.status ?? "no response"} for batch of ${ids.length}`);
      continue;
    }

    successfulCalls += 1;
    for (const entry of batch) {
      const payload = data[entry.mint];
      const usdPrice = payload?.usdPrice;
      const liquidity = payload?.liquidity;
      if (usdPrice == null || !Number.isFinite(usdPrice) || usdPrice <= 0) continue;
      if (liquidity == null || !Number.isFinite(liquidity) || liquidity < JUPITER_MIN_LIQUIDITY_USD) continue;

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
    { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal },
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
    const data = (await res.json()) as Record<string, JupiterPriceEntry>;
    diagnostic.responseRowCount = Object.keys(data).length;
    diagnostic.success = true;
    return { data, diagnostic };
  } catch (err) {
    await cancelResponseBodyQuietly(res);
    diagnostic.errorClass = err instanceof Error && err.name ? err.name : typeof err;
    diagnostic.errorMessage = err instanceof Error ? err.message : String(err);
    return { data: null, diagnostic };
  }
}
