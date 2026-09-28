import { resolveChainId } from "./index";
import { admitSupplyBuckets } from "../supply";
import { isRecord } from "../type-guards";

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

function projectLegacyChainRow(row: unknown): Record<string, unknown> | null {
  if (!isRecord(row)) return null;
  let projected: Record<string, unknown> | null = null;
  for (const key of CHAIN_CIRCULATING_KEYS) {
    if (row[key] !== null) continue;
    projected ??= { ...row };
    projected[key] = 0;
  }
  return projected;
}

/**
 * RELEASE A public-wire projection (CR-13). The stablecoins cache stores an unavailable chain observation
 * as `null` so internal consumers (chain aggregation, snapshots, weighting, gap reconciliation) never read it
 * as supply; the public `/api/stablecoins` wire keeps emitting the pre-CR-13 value (`0`) for those keys until
 * the Release B activation deletes this projection. Payloads without a `null` chain key are returned by identity.
 */
export function projectLegacyChainCirculatingWire<T extends { peggedAssets: readonly unknown[] }>(payload: T): T {
  let assets: unknown[] | null = null;
  for (let index = 0; index < payload.peggedAssets.length; index += 1) {
    const asset = payload.peggedAssets[index];
    if (!isRecord(asset) || !isRecord(asset.chainCirculating)) continue;
    const chainCirculating = asset.chainCirculating;
    let projectedChains: Record<string, unknown> | null = null;
    for (const [label, row] of Object.entries(chainCirculating)) {
      const projected = projectLegacyChainRow(row);
      if (!projected) continue;
      projectedChains ??= { ...chainCirculating };
      projectedChains[label] = projected;
    }
    if (!projectedChains) continue;
    assets ??= [...payload.peggedAssets];
    assets[index] = { ...asset, chainCirculating: projectedChains };
  }
  return assets ? { ...payload, peggedAssets: assets } : payload;
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
