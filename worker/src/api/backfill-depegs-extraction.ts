import { DAY_SECONDS } from "@shared/lib/time-constants";
import { getCirculatingRaw } from "@shared/lib/supply";
import { binarySearchNearest } from "../lib/binary-search";
import { DEPEG_CONFIRMATION_SUPPLY_THRESHOLD, DEPEG_EVENT_MIN_SUPPLY_USD } from "../lib/constants";
import { deriveDepegSignal } from "../lib/depeg-signals";
import {
  buildPriceValidationContext,
  type PriceReasonablenessOptions,
  validatePriceCandidateAgainstReference,
} from "../lib/price-validation";
import { getDepegThresholdBps } from "../lib/constants";
import type { PricePoint } from "./backfill-price-sources";

export const BACKFILL_MIN_CONFIRM_POINTS = 2;
const BACKFILL_PENDING_MAX_GAP_SEC = 6 * 3600;

export interface SupplyPoint {
  date: string;
  circulating?: Record<string, number>;
}

export interface BackfillEvent {
  pegType: string;
  direction: string;
  peakDeviationBps: number;
  startedAt: number;
  endedAt: number | null;
  startPrice: number;
  peakPrice: number;
  recoveryPrice: number | null;
  pegRef: number;
}

export interface SupplySnapshot {
  ts: number;
  supply: number;
}

export interface BackfillEventExtractionOptions {
  forceConfirmation?: boolean;
  confirmationMinPoints?: number;
  confirmationMaxGapSec?: number;
  extremeSinglePointBps?: number | null;
  missingSupplyUsd?: number | null;
}

export function parseSupplyData(tokens: SupplyPoint[]): SupplySnapshot[] {
  const map = new Map<number, number>();
  for (const point of tokens) {
    const ts = Number.parseInt(point.date, 10);
    if (Number.isNaN(ts)) continue;
    map.set(ts, getCirculatingRaw(point));
  }
  return Array.from(map.entries())
    .map(([ts, supply]) => ({ ts, supply }))
    .sort((a, b) => a.ts - b.ts);
}

export function findNearestSupply(supplyByDate: SupplySnapshot[], timestamp: number): number | null {
  if (supplyByDate.length === 0) return null;
  const nearest = binarySearchNearest(supplyByDate, timestamp, (snapshot) => snapshot.ts);
  return nearest?.supply ?? null;
}

export function extractDepegEvents(
  prices: PricePoint[],
  getPegRef: (timestamp: number) => number,
  pegType: string,
  supplyByDate: SupplySnapshot[],
  fxRates?: Record<string, number>,
  priceValidationOpts?: PriceReasonablenessOptions,
  options?: BackfillEventExtractionOptions,
): BackfillEvent[] {
  const threshold = getDepegThresholdBps(pegType);
  const confirmationMinPoints = Math.max(1, options?.confirmationMinPoints ?? BACKFILL_MIN_CONFIRM_POINTS);
  const confirmationMaxGapSec = Math.max(1, options?.confirmationMaxGapSec ?? BACKFILL_PENDING_MAX_GAP_SEC);
  const extremeSinglePointBps = options?.extremeSinglePointBps ?? null;
  const events: BackfillEvent[] = [];
  let current: BackfillEvent | null = null;
  const validationContext = buildPriceValidationContext({
    pegType,
    navToken: priceValidationOpts?.navToken,
    commodityOunces: priceValidationOpts?.commodityOunces,
  });
  let pending: {
    direction: string;
    count: number;
    firstTs: number;
    lastTs: number;
    peakBps: number;
    startPrice: number;
    peakPrice: number;
    pegRef: number;
  } | null = null;

  function resolveSupply(timestamp: number): number | null {
    if (supplyByDate.length > 0) {
      return findNearestSupply(supplyByDate, timestamp);
    }
    const missingSupplyUsd = options?.missingSupplyUsd;
    return typeof missingSupplyUsd === "number" && Number.isFinite(missingSupplyUsd)
      ? missingSupplyUsd
      : null;
  }

  function promotePending(): void {
    if (!pending) return;
    current = {
      pegType,
      direction: pending.direction,
      peakDeviationBps: pending.peakBps,
      startedAt: pending.firstTs,
      endedAt: null,
      startPrice: pending.startPrice,
      peakPrice: pending.peakPrice,
      recoveryPrice: null,
      pegRef: pending.pegRef,
    };
    pending = null;
  }

  for (const point of prices) {
    const { timestamp, price } = point;
    if (price <= 0) continue;

    const supply = resolveSupply(timestamp);
    if (supply === null || supply < DEPEG_EVENT_MIN_SUPPLY_USD) continue;

    const pegRef = getPegRef(timestamp);
    if (pegRef <= 0) continue;
    const decision = validatePriceCandidateAgainstReference(price, validationContext, "historical_backfill", {
      price: pegRef,
      type: fxRates ? "fresh" : "none",
    });
    if (!decision.accepted) continue;

    const depegSignal = deriveDepegSignal(price, pegRef);
    if (!depegSignal) continue;
    const { bps, absBps, direction } = depegSignal;
    const isLargeCap = supply >= DEPEG_CONFIRMATION_SUPPLY_THRESHOLD;

    if (absBps >= threshold) {
      if (current) {
        if (current.direction !== direction) {
          current.endedAt = timestamp;
          current.recoveryPrice = price;
          events.push(current);
          current = null;
        } else {
          if (absBps > Math.abs(current.peakDeviationBps)) {
            current.peakDeviationBps = bps;
            current.peakPrice = price;
          }
          continue;
        }
      }

      const requiresConfirmation = options?.forceConfirmation === true || isLargeCap;
      if (!requiresConfirmation || (extremeSinglePointBps != null && absBps >= extremeSinglePointBps)) {
        current = {
          pegType,
          direction,
          peakDeviationBps: bps,
          startedAt: timestamp,
          endedAt: null,
          startPrice: price,
          peakPrice: price,
          recoveryPrice: null,
          pegRef,
        };
        pending = null;
      } else if (!pending || pending.direction !== direction || timestamp - pending.lastTs > confirmationMaxGapSec) {
        pending = {
          direction,
          count: 1,
          firstTs: timestamp,
          lastTs: timestamp,
          peakBps: bps,
          startPrice: price,
          peakPrice: price,
          pegRef,
        };
      } else {
        pending.count++;
        pending.lastTs = timestamp;
        if (absBps > Math.abs(pending.peakBps)) {
          pending.peakBps = bps;
          pending.peakPrice = price;
        }
        if (pending.count >= confirmationMinPoints) {
          promotePending();
        }
      }
    } else {
      if (current) {
        current.endedAt = timestamp;
        current.recoveryPrice = price;
        events.push(current);
        current = null;
      }
      pending = null;
    }
  }

  if (current) {
    const lastTs = prices[prices.length - 1].timestamp;
    const now = Math.floor(Date.now() / 1000);
    if (now - lastTs > 7 * DAY_SECONDS) {
      current.endedAt = lastTs;
    }
    events.push(current);
  }

  return events;
}
