import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonAdapterInput,
  freshnessMetadataFromTimestamp,
  parseTimestampLikeToUnixSeconds,
  reserveDegradedWarning,
  reserveInfoWarning,
} from "./helpers";

interface SolsticeTimelinePoint {
  ts?: string | number;
  date?: string;
  reserves?: number;
  supply?: number;
  delta_neutral?: boolean;
  overcollateralized?: boolean;
}

interface SolsticeReservesTotal {
  value?: unknown;
}

interface SolsticeSevAttestation {
  addr?: unknown;
}

interface SolsticeMerkleRootAttestation {
  rootHash?: unknown;
  ts?: string | number;
}

interface SolsticeSnapshotAttestation {
  ts?: string | number;
}

interface SolsticeZkpSide {
  params?: unknown;
}

interface SolsticeZkpAttestation {
  liabilities?: SolsticeZkpSide;
  collateral?: SolsticeZkpSide;
}

interface SolsticeAttestationsBlock {
  sev?: SolsticeSevAttestation | null;
  merkle_root?: SolsticeMerkleRootAttestation | null;
  snapshot?: SolsticeSnapshotAttestation | null;
  zkp?: SolsticeZkpAttestation | null;
}

interface SolsticeDashboardPayload {
  res?: string;
  data?: {
    collateralization?: number;
    ts?: string | number;
    attestations?: SolsticeAttestationsBlock | null;
    reserves?: {
      verifiability?: string | number;
      interval?: string;
      timeline?: SolsticeTimelinePoint[];
      total_reserves?: SolsticeReservesTotal | null;
      total_supply?: SolsticeReservesTotal | null;
    };
  };
}

/** Tolerance for the SO3 cross-check between the `reserves.total_*` headline
 *  totals and the values carried by the selected timeline point. */
const SOLSTICE_TOTAL_MISMATCH_TOLERANCE = 0.005;

/** SO2: proof artifacts the dashboard publishes beside the aggregate timeline.
 *  Ids and hashes only — nothing here is verified in-adapter, so the emitted
 *  basis informs an evidence-class review but never upgrades the class. */
export interface SolsticeEvidenceBasis {
  merkleRoot: string | null;
  zkpLiabilitiesHash: string | null;
  zkpCollateralHash: string | null;
  snapshotTsMs: number | null;
  sevAttestation: string | null;
}

function zkpDataHash(side: SolsticeZkpSide | undefined): string | null {
  if (typeof side?.params !== "string") return null;
  try {
    const params = JSON.parse(side.params) as { dataHash?: unknown } | null;
    return typeof params?.dataHash === "string" && params.dataHash.length > 0 ? params.dataHash : null;
  } catch {
    // Params is upstream JSON-in-a-string; an unparseable side reads as missing.
    return null;
  }
}

function buildEvidenceBasis(
  attestations: SolsticeAttestationsBlock | null | undefined,
): SolsticeEvidenceBasis | null {
  if (!attestations || typeof attestations !== "object") return null;
  const rawMerkleRoot = attestations.merkle_root?.rootHash;
  const rawSevAddr = attestations.sev?.addr;
  const rawSnapshotTs = attestations.snapshot?.ts;
  const snapshotTs = typeof rawSnapshotTs === "number"
    ? rawSnapshotTs
    : typeof rawSnapshotTs === "string" ? Number(rawSnapshotTs) : Number.NaN;
  const basis: SolsticeEvidenceBasis = {
    merkleRoot: typeof rawMerkleRoot === "string" && rawMerkleRoot.length > 0 ? rawMerkleRoot : null,
    zkpLiabilitiesHash: zkpDataHash(attestations.zkp?.liabilities),
    zkpCollateralHash: zkpDataHash(attestations.zkp?.collateral),
    snapshotTsMs: Number.isFinite(snapshotTs) && snapshotTs > 0 ? snapshotTs : null,
    sevAttestation: typeof rawSevAddr === "string" && rawSevAddr.length > 0 ? rawSevAddr : null,
  };
  return Object.values(basis).some((value) => value != null) ? basis : null;
}

function timelineTotalMismatchWarning(
  label: string,
  attestedTotal: number | null,
  timelineValue: number,
): LiveReserveWarning | null {
  if (attestedTotal == null) {
    return reserveInfoWarning(
      "solstice-attested-total-unavailable",
      `Solstice dashboard omitted reserves.${label}; the headline total could not be cross-checked against the timeline`,
    );
  }
  const deviation = Math.abs(attestedTotal - timelineValue) / Math.abs(timelineValue);
  if (deviation <= SOLSTICE_TOTAL_MISMATCH_TOLERANCE) return null;
  return reserveDegradedWarning(
    "solstice-timeline-total-mismatch",
    `Solstice headline ${label} ${attestedTotal.toFixed(2)} deviates from the timeline value `
      + `${timelineValue.toFixed(2)} by ${(deviation * 100).toFixed(3)}% (tolerance 0.5%)`,
  );
}

function latestTimelinePoint(points: SolsticeTimelinePoint[] | undefined): SolsticeTimelinePoint | null {
  if (!Array.isArray(points) || points.length === 0) return null;
  return points
    .slice()
    .sort((left, right) => (
      (parseTimestampLikeToUnixSeconds(right.ts) ?? 0) - (parseTimestampLikeToUnixSeconds(left.ts) ?? 0)
    ))[0] ?? null;
}

export function adaptSolsticeAttestation(payload: SolsticeDashboardPayload): AdapterResult {
  if (payload.res !== "ok" || !payload.data?.reserves) {
    throw new Error("solstice-attestation returned an invalid response");
  }

  const point = latestTimelinePoint(payload.data.reserves.timeline);
  const totalReserveUsd = point?.reserves;
  const supplyUsd = point?.supply;
  if (
    typeof totalReserveUsd !== "number" || !Number.isFinite(totalReserveUsd) || totalReserveUsd <= 0
    || typeof supplyUsd !== "number" || !Number.isFinite(supplyUsd) || supplyUsd <= 0
  ) {
    throw new Error("solstice-attestation missing reserve/supply timeline values");
  }

  const sourceTimestamp =
    parseTimestampLikeToUnixSeconds(payload.data.ts)
    ?? parseTimestampLikeToUnixSeconds(point?.ts)
    ?? parseTimestampLikeToUnixSeconds(point?.date);
  const freshnessMetadata = freshnessMetadataFromTimestamp(
    sourceTimestamp,
    "solstice-attestation-api",
    "Solstice attestation payload did not expose a trustworthy source timestamp",
  );
  const collateralizationRatio = totalReserveUsd / supplyUsd;

  // SO2: same-run proof artifacts; SO3: headline totals must reconcile with the
  // timeline values the adapter actually scores.
  const warnings: LiveReserveWarning[] = [];
  const evidenceBasis = buildEvidenceBasis(payload.data.attestations);
  if (!evidenceBasis) {
    warnings.push(reserveInfoWarning(
      "solstice-attestations-unavailable",
      "Solstice attestation payload omitted the attestations block; "
        + "the merkle-root/ZKP/snapshot/SEV evidence basis is unavailable this run",
    ));
  } else {
    const missing = Object.entries(evidenceBasis).filter(([, value]) => value == null).map(([key]) => key);
    if (missing.length > 0) {
      warnings.push(reserveInfoWarning(
        "solstice-evidence-basis-partial",
        `Solstice attestation payload omitted proof fields: ${missing.join(", ")}`,
      ));
    }
  }
  // details carries freshness provenance on the unverified path; keep it.
  const details: Record<string, unknown> = { ...("details" in freshnessMetadata ? freshnessMetadata.details : {}) };
  if (evidenceBasis) details.evidenceBasis = evidenceBasis;
  const rawAttestedReserves = payload.data.reserves.total_reserves?.value;
  const rawAttestedSupply = payload.data.reserves.total_supply?.value;
  const attestedTotalReservesUsd = typeof rawAttestedReserves === "number" && Number.isFinite(rawAttestedReserves)
    ? rawAttestedReserves
    : null;
  const attestedTotalSupplyUsd = typeof rawAttestedSupply === "number" && Number.isFinite(rawAttestedSupply)
    ? rawAttestedSupply
    : null;
  for (const mismatch of [
    timelineTotalMismatchWarning("total_reserves", attestedTotalReservesUsd, totalReserveUsd),
    timelineTotalMismatchWarning("total_supply", attestedTotalSupplyUsd, supplyUsd),
  ]) {
    if (mismatch) warnings.push(mismatch);
  }

  return {
    slices: [
      {
        name: "Aggregate Solstice attested reserves",
        pct: 100,
        risk: "high",
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...freshnessMetadata,
      totalReserveUsd,
      supplyUsd,
      collateralizationRatio,
      publishedCollateralizationRatio: payload.data.collateralization,
      deltaNeutral: point?.delta_neutral,
      overcollateralized: point?.overcollateralized,
      verifiability: payload.data.reserves.verifiability,
      interval: payload.data.reserves.interval,
      ...(attestedTotalReservesUsd != null ? { attestedTotalReservesUsd } : {}),
      ...(attestedTotalSupplyUsd != null ? { attestedTotalSupplyUsd } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
      sourceProvenance:
        "Aggregate solvency proof only. Kept proof-class until timestamped asset-category composition is source-verified.",
    },
  };
}

export async function fetchSolsticeAttestationReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const payload = await fetchJsonAdapterInput<SolsticeDashboardPayload>(
    config,
    "solstice-attestation",
    signal,
    12_000,
    ctx,
  );
  return adaptSolsticeAttestation(payload);
}
