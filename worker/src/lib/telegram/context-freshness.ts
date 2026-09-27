import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { isFiniteNumber } from "@shared/lib/type-guards";
import type { StablecoinData } from "@shared/types/market";
import { DEWS_STALE_DEX_LIQUIDITY_SEC } from "../dews/source-state/budgets";
import { classifyFreshness } from "../status/freshness-oracle";

/**
 * Optional market context shown beside Telegram alerts and `/status` replies is
 * assessed against budgets the producers/consumers already own — no
 * Telegram-specific numbers:
 * - supply: the published `/api/stablecoins` endpoint budget;
 * - DEX liquidity: the DEWS DEX-liquidity input budget.
 */
export const TELEGRAM_CONTEXT_BUDGET_SEC = {
  supply: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  dexLiquidity: DEWS_STALE_DEX_LIQUIDITY_SEC,
} as const;

export interface TelegramContextClock {
  /** Producer observation clock (unix seconds), or `null` when none is recorded. */
  observedAt: number | null;
  /** Budget the clock was assessed against. */
  budgetSec: number;
  /** True only for a recorded clock within `budgetSec` (boundary inclusive). A missing clock is never current. */
  current: boolean;
}

export function assessTelegramContextClock(
  observedAt: number | null | undefined,
  nowSec: number,
  budgetSec: number,
): TelegramContextClock {
  const clock = isFiniteNumber(observedAt) ? observedAt : null;
  const { state } = classifyFreshness(
    {
      job: "telegram-context",
      lastSuccessAt: clock,
      lastRunAt: clock,
      expectedIntervalSec: budgetSec,
      lastStatus: clock == null ? null : "ok",
    },
    { watchAt: { absoluteSec: budgetSec }, staleAt: { absoluteSec: budgetSec } },
    nowSec,
  );
  return { observedAt: clock, budgetSec, current: state === "fresh" };
}

export interface TelegramSupplyContext extends TelegramContextClock {
  /** `null` when the asset or its current peg buckets are absent/empty/invalid; `0` only for an explicit zero. */
  supplyUsd: number | null;
}

/**
 * Project one asset's current supply with its observation clock: the asset's own
 * `supplyObservedAt` (retained supply can be older than the publication) bounded by
 * the stablecoins publication time, else the publication time alone.
 */
export function projectTelegramSupplyContext(
  asset: StablecoinData | undefined,
  publicationUpdatedAt: number | null,
  nowSec: number,
): TelegramSupplyContext {
  const rawObservedAt = asset?.supplyObservedAt;
  const assetObservedAt = isFiniteNumber(rawObservedAt) ? rawObservedAt : null;
  const observedAt = assetObservedAt != null && publicationUpdatedAt != null
    ? Math.min(assetObservedAt, publicationUpdatedAt)
    : assetObservedAt ?? publicationUpdatedAt;
  return {
    supplyUsd: getCirculatingRawOrNull(asset),
    ...assessTelegramContextClock(observedAt, nowSec, TELEGRAM_CONTEXT_BUDGET_SEC.supply),
  };
}
