import { resolveChainId } from "../../types/chain-identity";
import type { SupplyChainGuardProvenance } from "../../types/supply";
import { admitSupplyBuckets, getCirculatingRawOrNull } from "../supply";

export interface ChainCirculatingNormalizationDiagnostics {
  droppedRows: number;
  droppedChainIds: string[];
}

/**
 * One canonical chain observation. `current: null` means the chain row exists but its current supply
 * was not observed (absent/empty/invalid provider buckets); it is never a zero and never pairs into a
 * delta. Historical keys are `undefined` when unavailable. An observed `0` stays a real zero.
 */
export interface ChainCirculatingPoint {
  current: number | null;
  circulatingPrevDay?: number;
  circulatingPrevWeek?: number;
  circulatingPrevMonth?: number;
}

export type RawChainCirculating = Record<string, {
  chainId?: string;
  current?: number | null;
  circulatingPrevDay?: number | null;
  circulatingPrevWeek?: number | null;
  circulatingPrevMonth?: number | null;
}>;

export const CHAIN_CIRCULATING_KEYS = ["current", "circulatingPrevDay", "circulatingPrevWeek", "circulatingPrevMonth"] as const;

/**
 * Normalize one provider chain-circulating value (a peg-bucket record or an already-summed number) to the
 * stored scalar: the finite nonnegative total, or `null` when absent (`{}`/`null`) or invalid. Numeric zero
 * (`{peggedUSD: 0}` or `0`) stays `0`, so a genuine redemption to zero is still observable.
 */
export function normalizeChainSupplyValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const admission = admitSupplyBuckets(value);
  return admission.status === "observed" ? admission.total : null;
}

function recordDroppedRow(
  diagnostics: ChainCirculatingNormalizationDiagnostics | undefined,
  rawChainId: string,
): void {
  if (!diagnostics) return;
  diagnostics.droppedRows += 1;
  if (!diagnostics.droppedChainIds.includes(rawChainId)) diagnostics.droppedChainIds.push(rawChainId);
}

function sanitizeSupply(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addSupply(current: number, value: number): number {
  const total = current + value;
  return Number.isFinite(total) ? total : Number.MAX_VALUE;
}

export function canonicalizeChainCirculating(
  chainCirculating: RawChainCirculating | null | undefined,
  diagnostics?: ChainCirculatingNormalizationDiagnostics,
): Map<string, ChainCirculatingPoint> {

  const canonical = new Map<string, ChainCirculatingPoint>();
  if (!chainCirculating || typeof chainCirculating !== "object") {
    return canonical;
  }

  for (const [rawChainId, data] of Object.entries(chainCirculating)) {
    if (!data || typeof data !== "object") {
      recordDroppedRow(diagnostics, rawChainId);
      continue;
    }

    // Worker-generated rows retain their display-label key for compatibility,
    // but the explicit canonical id is authoritative when present. Unknown or
    // malformed ids fall back to the legacy label resolver.
    const chainId = (typeof data.chainId === "string" ? resolveChainId(data.chainId) : null)
      ?? resolveChainId(rawChainId);
    if (!chainId) {
      recordDroppedRow(diagnostics, rawChainId);
      continue;
    }

    // Missing/invalid current stays unavailable (`null`), never a zero that would read as a redemption.
    // Alias rows merge only when every alias observed the key; one unavailable alias makes the merged
    // observation unavailable, so a partial sum cannot pair against a complete baseline.
    const current = sanitizeSupply(data.current) ?? null;
    const circulatingPrevDay = sanitizeSupply(data.circulatingPrevDay);
    const circulatingPrevWeek = sanitizeSupply(data.circulatingPrevWeek);
    const circulatingPrevMonth = sanitizeSupply(data.circulatingPrevMonth);
    const existing = canonical.get(chainId);

    if (existing) {
      existing.current = existing.current == null || current == null ? null : addSupply(existing.current, current);
      existing.circulatingPrevDay = existing.circulatingPrevDay == null || circulatingPrevDay == null
        ? undefined : addSupply(existing.circulatingPrevDay, circulatingPrevDay);
      existing.circulatingPrevWeek = existing.circulatingPrevWeek == null || circulatingPrevWeek == null
        ? undefined : addSupply(existing.circulatingPrevWeek, circulatingPrevWeek);
      existing.circulatingPrevMonth = existing.circulatingPrevMonth == null || circulatingPrevMonth == null
        ? undefined : addSupply(existing.circulatingPrevMonth, circulatingPrevMonth);
      continue;
    }

    canonical.set(chainId, {
      current,
      circulatingPrevDay,
      circulatingPrevWeek,
      circulatingPrevMonth,
    });
  }

  return canonical;
}

/** A chain breakdown conserves its total when they differ by at most max($0.01, total × 1e-9). */
export function chainSupplyReconciles(chainSupply: number, total: number): boolean {
  return Math.abs(chainSupply - total) <= Math.max(0.01, total * 1e-9);
}

/**
 * Display rows for a chain-dropout carry. The published row keeps each carried chain at `current: null`
 * while the headline re-adds its frozen baseline, so a breakdown view shows each `carried-baseline` chain at
 * that `baselineUsd`, but only when the complete displayed breakdown then sums to the published headline.
 * Otherwise (e.g. an attribution-ambiguous held total the fresh chains have moved away from) the published
 * rows are returned unchanged. Presentation only: never feed this into aggregates, scores or weights.
 */
export function chainCirculatingForDisplay(asset: {
  circulating?: Record<string, number>;
  chainCirculating?: RawChainCirculating;
  supplyChainGuard?: Pick<SupplyChainGuardProvenance, "chains">;
}): RawChainCirculating | undefined {
  const rows = asset.chainCirculating;
  const carried = asset.supplyChainGuard?.chains.filter((chain) => chain.resolution === "carried-baseline") ?? [];
  if (!rows || carried.length === 0) return rows;
  const display: RawChainCirculating = { ...rows };
  for (const chain of carried) {
    const row = display[chain.chainLabel];
    if (!row || row.current != null) return rows;
    display[chain.chainLabel] = { ...row, current: chain.baselineUsd };
  }
  let breakdown = 0;
  for (const row of Object.values(display)) {
    const current = normalizeChainSupplyValue(row.current);
    if (current == null) return rows;
    breakdown += current;
  }
  const headline = getCirculatingRawOrNull(asset);
  return headline != null && chainSupplyReconciles(breakdown, headline) ? display : rows;
}
