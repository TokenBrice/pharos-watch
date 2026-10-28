import { compareMethodologyVersions } from "./methodology-versions/base";
import {
  SupplyChainGuardProvenanceSchema,
  SupplyObservationProvenanceSchema,
  type SupplyChainGuardProvenance,
  type SupplyObservationProvenance,
} from "../types/market";

/**
 * One coverage authority for recorded supply observations (K-031). `complete`: provenance was recorded and
 * excludes no chain. `partial`: the numeric amount is an observed remainder that excludes unavailable chains.
 * `unknown`: coverage was never recorded (legacy rows, prior Workers, backfills) or its metadata is invalid;
 * unknown is never complete.
 */
export type SupplyCoverage = "complete" | "partial" | "unknown";

/**
 * First Pricing Pipeline version whose published rows always carry `supplyChainGuard` when a chain was
 * excluded, so a guard-less row of a dated envelope at or above it attests full chain coverage.
 */
const GUARD_CAPABLE_PRICING_PIPELINE_VERSION = "6.55";

interface SupplyProvenanceSource {
  supplySource?: unknown;
  supplyObservedAt?: unknown;
  supplyChainGuard?: unknown;
}

/** A chain-dropout guard whose published amount omits at least one unavailable chain. */
function isSupplyChainGuardPartial(guard: SupplyChainGuardProvenance): boolean {
  if (guard.partialCoverage === true) return true;
  return guard.status === "chains-unavailable" && guard.chains.some((chain) => chain.resolution === "unavailable");
}

/**
 * Provenance of an admitted current row, attesting that the caller inspected it. An invalid guard makes the
 * whole record unknown (`null`) rather than silently dropping the exclusion evidence. Source and clock
 * absence stay null; no clock is ever synthesized.
 */
export function buildSupplyObservationProvenance(row: SupplyProvenanceSource): SupplyObservationProvenance | null {
  let supplyChainGuard: SupplyChainGuardProvenance | null = null;
  if (row.supplyChainGuard != null) {
    const parsed = SupplyChainGuardProvenanceSchema.safeParse(row.supplyChainGuard);
    if (!parsed.success) return null;
    supplyChainGuard = parsed.data;
  }
  const observedAt = row.supplyObservedAt;
  return {
    supplySource: typeof row.supplySource === "string" ? row.supplySource : null,
    supplyObservedAt: typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt >= 0
      ? observedAt
      : null,
    supplyChainGuard,
  };
}

/** Parses stored/wire provenance (JSON text or object). `invalid` flags malformed metadata, which reads unknown. */
export function parseSupplyObservationProvenance(
  raw: unknown,
): { provenance: SupplyObservationProvenance | null; invalid: boolean } {
  if (raw == null) return { provenance: null, invalid: false };
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { provenance: null, invalid: true };
    }
  }
  const parsed = SupplyObservationProvenanceSchema.safeParse(value);
  return parsed.success ? { provenance: parsed.data, invalid: false } : { provenance: null, invalid: true };
}

export function classifySupplyCoverage(provenance: SupplyObservationProvenance | null | undefined): SupplyCoverage {
  if (provenance == null) return "unknown";
  return provenance.supplyChainGuard != null && isSupplyChainGuardPartial(provenance.supplyChainGuard)
    ? "partial"
    : "complete";
}

/** True only for a string Pricing Pipeline version at or above the guard-capable contract; malformed is false. */
export function isGuardCapablePricingPipelineVersion(version: unknown): boolean {
  if (typeof version !== "string") return false;
  try {
    return compareMethodologyVersions(version, GUARD_CAPABLE_PRICING_PIPELINE_VERSION) >= 0;
  } catch {
    return false;
  }
}

/**
 * Provenance of a row read from a dated immutable snapshot envelope. A present guard establishes its own
 * disposition; a guard-less row is recorded coverage only when the envelope's Pricing Pipeline version is
 * guard-capable. Otherwise coverage stays unknown, never synthesized as complete.
 */
export function projectEnvelopeSupplyProvenance(
  row: SupplyProvenanceSource,
  pricingPipelineVersion: unknown,
): SupplyObservationProvenance | null {
  if (row.supplyChainGuard == null && !isGuardCapablePricingPipelineVersion(pricingPipelineVersion)) return null;
  return buildSupplyObservationProvenance(row);
}
