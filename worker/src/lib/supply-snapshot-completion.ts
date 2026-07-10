import { sha256Hex } from "@shared/lib/sha256";
import { getCache } from "./db-cache";
import type { StablecoinPublicationWaiver } from "./stablecoin-publication-coverage";

export const SNAPSHOT_SUPPLY_LAST_WRITE_KEY = "snapshot-supply:last-write";
export const SNAPSHOT_CHAIN_SUPPLY_LAST_WRITE_KEY = "snapshot-chain-supply:last-write";
export const SUPPLY_SNAPSHOT_COVERAGE_VERSION = 2;

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export interface SupplySnapshotCoverageExpectation {
  expectedActiveCount: number;
  coverageDigest: string;
}

export interface SupplySnapshotCompletionMarkerInput {
  snapshotDate: number;
  coverage: SupplySnapshotCoverageExpectation;
  accountedActiveCount: number;
  ownedRowIds: readonly string[];
}

export interface SupplySnapshotCompletionOptions {
  cacheKey?: string;
  expectedCoverage?: SupplySnapshotCoverageExpectation;
}

export interface CompletedSupplySnapshot {
  snapshotDate: number;
  updatedAt: number;
  exactCoverageVerified: boolean;
  ownedRowIds: string[] | null;
}

function canonicalizeRequiredActiveIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function canonicalizeAppliedWaivers(
  waivers: readonly StablecoinPublicationWaiver[],
): Array<{ stablecoinId: string; owner: string; expiresAt: number }> {
  return waivers
    .map((waiver) => ({
      stablecoinId: waiver.stablecoinId,
      owner: waiver.owner,
      expiresAt: waiver.expiresAt,
    }))
    .sort((a, b) => (
      a.stablecoinId.localeCompare(b.stablecoinId)
      || a.owner.localeCompare(b.owner)
      || a.expiresAt - b.expiresAt
    ));
}

function parseCanonicalOwnedRowIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    return null;
  }
  const ids = value as string[];
  const canonicalIds = [...new Set(ids)].sort();
  return ids.length === canonicalIds.length && ids.every((id, index) => id === canonicalIds[index])
    ? ids
    : null;
}

export function buildSupplySnapshotCoverageExpectation(
  requiredActiveIds: readonly string[],
  appliedWaivers: readonly StablecoinPublicationWaiver[],
): SupplySnapshotCoverageExpectation {
  const canonicalRequiredActiveIds = canonicalizeRequiredActiveIds(requiredActiveIds);
  const canonicalAppliedWaivers = canonicalizeAppliedWaivers(appliedWaivers);
  return {
    expectedActiveCount: canonicalRequiredActiveIds.length,
    coverageDigest: sha256Hex(JSON.stringify({
      requiredActiveIds: canonicalRequiredActiveIds,
      appliedWaivers: canonicalAppliedWaivers,
    })),
  };
}

export function buildSupplySnapshotCompletionMarker(
  input: SupplySnapshotCompletionMarkerInput,
): Record<string, unknown> {
  return {
    snapshotDate: input.snapshotDate,
    coverageVersion: SUPPLY_SNAPSHOT_COVERAGE_VERSION,
    expectedActiveCount: input.coverage.expectedActiveCount,
    accountedActiveCount: input.accountedActiveCount,
    coverageDigest: input.coverage.coverageDigest,
    ownedRowIds: [...new Set(input.ownedRowIds)].sort(),
  };
}

export async function getCompletedSupplySnapshot(
  db: D1Database,
  options: SupplySnapshotCompletionOptions = {},
): Promise<CompletedSupplySnapshot | null> {
  const cached = await getCache(db, options.cacheKey ?? SNAPSHOT_SUPPLY_LAST_WRITE_KEY);
  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached.value) as {
      snapshotDate?: unknown;
      coverageVersion?: unknown;
      expectedActiveCount?: unknown;
      accountedActiveCount?: unknown;
      coverageDigest?: unknown;
      ownedRowIds?: unknown;
      writtenRows?: unknown;
    };
    const ownedRowIds = parseCanonicalOwnedRowIds(parsed.ownedRowIds);
    const structurallyExact = parsed.coverageVersion === SUPPLY_SNAPSHOT_COVERAGE_VERSION
      && typeof parsed.expectedActiveCount === "number"
      && Number.isInteger(parsed.expectedActiveCount)
      && parsed.expectedActiveCount >= 0
      && typeof parsed.accountedActiveCount === "number"
      && parsed.expectedActiveCount === parsed.accountedActiveCount
      && typeof parsed.coverageDigest === "string"
      && SHA_256_HEX_PATTERN.test(parsed.coverageDigest)
      && ownedRowIds != null;
    const matchesExpectedCoverage = options.expectedCoverage == null || (
      parsed.expectedActiveCount === options.expectedCoverage.expectedActiveCount
      && parsed.coverageDigest === options.expectedCoverage.coverageDigest
    );
    return typeof parsed.snapshotDate === "number" && Number.isFinite(parsed.snapshotDate)
      ? {
          snapshotDate: parsed.snapshotDate,
          updatedAt: cached.updatedAt,
          exactCoverageVerified: structurallyExact && matchesExpectedCoverage,
          ownedRowIds: structurallyExact ? ownedRowIds : null,
        }
      : null;
  } catch {
    return null;
  }
}
