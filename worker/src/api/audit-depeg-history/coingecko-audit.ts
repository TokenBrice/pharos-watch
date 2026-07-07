import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { cgHeaders, cgUrl } from "../../lib/coingecko";
import { mapWithConcurrency } from "../../lib/concurrency";
import { DEPEG_SECONDARY_THRESHOLD_RATIO, getDepegThresholdBps, USER_AGENT } from "../../lib/constants";
import type { DepegRow } from "../../lib/depeg-helpers";
import { deriveDepegSignal } from "../../lib/depeg-signals";
import { fetchWithRetry } from "../../lib/fetch-retry";
import {
  buildPriceValidationContext,
  loadPriceValidationReferences,
  validatePriceCandidate,
} from "../../lib/price-validation";

export type Verdict = "false_positive" | "confirmed" | "disputed" | "no_data" | "repaired" | "skipped" | "error";

export interface AuditedEvent {
  id: number;
  symbol: string;
  startedAt: number;
  peakBps: number;
  cgMaxBps: number | null;
  cgMaxSameDirectionBps?: number | null;
  cgMaxOppositeDirectionBps?: number | null;
  verdict: Verdict;
}

export interface AuditEventOutcome {
  event: DepegRow;
  auditedEvent: AuditedEvent;
  attemptedCgFetch: boolean;
  upstreamError: boolean;
  rejectedByValidationCount: number;
  falsePositiveFound: boolean;
  provenanceVerdict: Verdict | null;
  invalidatesProvenance: boolean;
}

const AUDIT_CG_FETCH_START_INTERVAL_MS = 200;
const AUDIT_CG_FETCH_CONCURRENCY = 4;

type PriceValidationReferences = Awaited<ReturnType<typeof loadPriceValidationReferences>>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createFetchStartLimiter(intervalMs: number): () => Promise<void> {
  let nextStartAt = 0;
  let tail = Promise.resolve();

  return async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const now = Date.now();
    const waitMs = Math.max(0, nextStartAt - now);
    nextStartAt = Math.max(now, nextStartAt) + intervalMs;
    release();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
  };
}

function getDeviationSignal(price: number | null | undefined, pegReference: number) {
  return price == null ? null : deriveDepegSignal(price, pegReference);
}

function toAuditedEvent(
  event: DepegRow,
  verdict: Verdict,
  cgDeviation: {
    cgMaxBps: number | null;
    cgMaxSameDirectionBps?: number | null;
    cgMaxOppositeDirectionBps?: number | null;
  },
): AuditedEvent {
  const auditedEvent: Omit<AuditedEvent, "verdict"> = {
    id: event.id,
    symbol: event.symbol,
    startedAt: event.started_at,
    peakBps: event.peak_deviation_bps,
    cgMaxBps: cgDeviation.cgMaxBps,
  };
  if ("cgMaxSameDirectionBps" in cgDeviation) {
    auditedEvent.cgMaxSameDirectionBps = cgDeviation.cgMaxSameDirectionBps;
  }
  if ("cgMaxOppositeDirectionBps" in cgDeviation) {
    auditedEvent.cgMaxOppositeDirectionBps = cgDeviation.cgMaxOppositeDirectionBps;
  }
  return { ...auditedEvent, verdict };
}

async function auditSingleEventWithCoinGecko(
  event: DepegRow,
  validationReferences: PriceValidationReferences | undefined,
  waitForCgFetchStart: () => Promise<void>,
): Promise<AuditEventOutcome> {
  const meta = TRACKED_META_BY_ID.get(event.stablecoin_id);
  const geckoId = meta?.geckoId;

  if (!geckoId) {
    return {
      event,
      auditedEvent: toAuditedEvent(event, "skipped", { cgMaxBps: null }),
      attemptedCgFetch: false,
      upstreamError: false,
      rejectedByValidationCount: 0,
      falsePositiveFound: false,
      provenanceVerdict: null,
      invalidatesProvenance: false,
    };
  }

  const threshold = getDepegThresholdBps(event.peg_type);
  const falsePositiveBar = Math.round(threshold * DEPEG_SECONDARY_THRESHOLD_RATIO);
  const validationContext = buildPriceValidationContext({
    stablecoinId: event.stablecoin_id,
    pegType: event.peg_type,
  });

  const from = event.started_at - 3600;
  const to = (event.ended_at ?? event.started_at) + 3600;
  let rejectedByValidationCount = 0;

  try {
    await waitForCgFetchStart();

    const cgEndpoint = cgUrl(
      `/coins/${geckoId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}&precision=full`,
    );
    const cgFetchHeaders = cgHeaders({ Accept: "application/json", "User-Agent": USER_AGENT });
    const cgRes = await fetchWithRetry(cgEndpoint, { headers: cgFetchHeaders }, 1);

    if (!cgRes?.ok) {
      console.warn(`[audit] CG fetch failed for ${event.symbol} (${geckoId}): ${cgRes?.status ?? "no response"}`);
      return {
        event,
        auditedEvent: toAuditedEvent(event, "error", { cgMaxBps: null }),
        attemptedCgFetch: true,
        upstreamError: true,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: null,
        invalidatesProvenance: false,
      };
    }

    const cgData = (await cgRes.json()) as { prices?: [number, number][] };
    const rawPrices = cgData.prices ?? [];
    const validatedPrices = rawPrices.filter(([, cgPrice]) => {
      if (typeof cgPrice !== "number" || !Number.isFinite(cgPrice) || cgPrice <= 0) {
        rejectedByValidationCount++;
        return false;
      }
      const verdict = validatePriceCandidate(
        cgPrice,
        validationContext,
        "historical_backfill",
        validationReferences,
      );
      if (!verdict.accepted) {
        rejectedByValidationCount++;
        return false;
      }
      return true;
    });

    if (validatedPrices.length === 0) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "no_data", { cgMaxBps: null }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "no_data",
        invalidatesProvenance: true,
      };
    }

    let maxCgBps = 0;
    let maxSameDirectionBps = 0;
    let maxOppositeDirectionBps = 0;
    for (const [, cgPrice] of validatedPrices) {
      const cgSignal = getDeviationSignal(cgPrice, event.peg_reference);
      if (cgSignal == null) continue;
      const cgBps = cgSignal.absBps;
      if (cgBps > maxCgBps) maxCgBps = cgBps;
      if (cgSignal.direction === event.direction) {
        if (cgBps > maxSameDirectionBps) maxSameDirectionBps = cgBps;
      } else if (cgBps > maxOppositeDirectionBps) {
        maxOppositeDirectionBps = cgBps;
      }
    }

    if (maxSameDirectionBps >= falsePositiveBar) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "confirmed", {
          cgMaxBps: maxCgBps,
          cgMaxSameDirectionBps: maxSameDirectionBps,
          cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
        }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "confirmed",
        invalidatesProvenance: false,
      };
    }

    if (maxOppositeDirectionBps >= falsePositiveBar) {
      return {
        event,
        auditedEvent: toAuditedEvent(event, "disputed", {
          cgMaxBps: maxCgBps,
          cgMaxSameDirectionBps: maxSameDirectionBps,
          cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
        }),
        attemptedCgFetch: true,
        upstreamError: false,
        rejectedByValidationCount,
        falsePositiveFound: false,
        provenanceVerdict: "disputed",
        invalidatesProvenance: true,
      };
    }

    return {
      event,
      auditedEvent: toAuditedEvent(event, "false_positive", {
        cgMaxBps: maxCgBps,
        cgMaxSameDirectionBps: maxSameDirectionBps,
        cgMaxOppositeDirectionBps: maxOppositeDirectionBps,
      }),
      attemptedCgFetch: true,
      upstreamError: false,
      rejectedByValidationCount,
      falsePositiveFound: true,
      provenanceVerdict: "false_positive",
      invalidatesProvenance: true,
    };
  } catch (err) {
    console.warn(`[audit] Error auditing ${event.symbol}:`, err);
    return {
      event,
      auditedEvent: toAuditedEvent(event, "error", { cgMaxBps: null }),
      attemptedCgFetch: true,
      upstreamError: true,
      rejectedByValidationCount,
      falsePositiveFound: false,
      provenanceVerdict: null,
      invalidatesProvenance: false,
    };
  }
}

export async function runCoinGeckoAuditBatch(
  db: D1Database,
  events: readonly DepegRow[],
): Promise<{ outcomes: AuditEventOutcome[]; attemptedCgFetches: number }> {
  const validationReferences = events.length > 0
    ? await loadPriceValidationReferences(db)
    : undefined;

  const waitForCgFetchStart = createFetchStartLimiter(AUDIT_CG_FETCH_START_INTERVAL_MS);
  const outcomes = await mapWithConcurrency(
    events,
    AUDIT_CG_FETCH_CONCURRENCY,
    (event) => auditSingleEventWithCoinGecko(event, validationReferences, waitForCgFetchStart),
  );
  const attemptedCgFetches = outcomes.filter((outcome) => outcome.attemptedCgFetch).length;
  return { outcomes, attemptedCgFetches };
}
