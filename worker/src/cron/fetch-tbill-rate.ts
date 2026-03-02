import { fetchWithRetry } from "../lib/fetch-retry";
import { setCache } from "../lib/db";
import { shouldAttemptFetch, recordOutcome } from "../lib/circuit-breaker";
import {
  TREASURY_FISCAL_DATA_URL,
  RISK_FREE_RATE_FALLBACK,
  CIRCUIT_SOURCE,
  USER_AGENT,
} from "../lib/constants";
import type { CronResult } from "../lib/db";

interface TreasuryResponse {
  data: { record_date: string; avg_interest_rate_amt: string }[];
}

export async function fetchTbillRate(db: D1Database, signal?: AbortSignal): Promise<CronResult> {
  if (!await shouldAttemptFetch(db, CIRCUIT_SOURCE.TREASURY_RATES)) {
    console.log("[fetch-tbill-rate] Circuit open, using fallback");
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return { metadata: "skipped: circuit open, wrote fallback" };
  }

  try {
    const res = await fetchWithRetry(TREASURY_FISCAL_DATA_URL, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });

    if (!res?.ok) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      console.warn(`[fetch-tbill-rate] API returned ${res?.status}, using fallback`);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return { metadata: `API error ${res?.status}, wrote fallback` };
    }

    const body = (await res.json()) as TreasuryResponse;
    const rate = parseFloat(body.data?.[0]?.avg_interest_rate_amt);

    if (Number.isNaN(rate) || rate < 0 || rate > 20) {
      await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
      console.warn(`[fetch-tbill-rate] Invalid rate ${rate}, using fallback`);
      await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
      return { metadata: `invalid rate ${rate}, wrote fallback` };
    }

    await setCache(db, "risk_free_rate", String(rate));
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, true);

    const recordDate = body.data?.[0]?.record_date ?? "unknown";
    console.log(`[fetch-tbill-rate] T-bill rate: ${rate}% (as of ${recordDate})`);
    return { itemCount: 1, metadata: `${rate}% (${recordDate})` };
  } catch (err) {
    await recordOutcome(db, CIRCUIT_SOURCE.TREASURY_RATES, false);
    console.error("[fetch-tbill-rate] Error:", err);
    await setCache(db, "risk_free_rate", String(RISK_FREE_RATE_FALLBACK));
    return { metadata: "error, wrote fallback" };
  }
}
