import { z } from "zod";
import type { StablecoinMeta } from "@shared/types/core";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  requireJsonInput,
  unverifiedFreshnessMetadata,
} from "./helpers";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

const ADAPTER_KEY = "afi-proof";
const REQUEST_TIMEOUT_MS = 12_000;

type AfiProofParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

const AfiVerifiedTotalsSchema = z
  .object({
    totalReserves: z.string(),
    totalLiabilities: z.string(),
  })
  .passthrough();

const AfiProofPayloadSchema = z
  .object({
    protocolId: z.string().min(1),
    symbol: z.string().min(1),
    // The AFI envelope serializes its totals and ratio as decimal strings.
    totalReserves: z.coerce.number().finite().nonnegative(),
    totalLiabilities: z.coerce.number().finite().nonnegative(),
    collateralRatio: z.coerce.number().finite(),
    timestampInMs: z.number().int().nonnegative(),
    active: z.boolean(),
    proof: z
      .object({
        metadata: z.object({
          proofId: z.string().min(1),
          feedId: z.string().min(1),
          version: z.string().min(1),
          keyVersion: z.number().int(),
          generatedAtEpoch: z.number().int().nonnegative(),
        }),
        zkProofs: z.unknown(),
        merkleProof: z.unknown(),
        teeAttestation: z.unknown(),
        verifiedTotals: AfiVerifiedTotalsSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type AfiProofPayload = z.output<typeof AfiProofPayloadSchema>;

function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * AFI (afiprotocol.xyz) aggregate proof-of-reserves envelope. The proof
 * verifies only aggregate reserve and liability totals: constituent assets,
 * custody and the as-of dates of the underlying assets are opaque
 * commitments, so proof generation is telemetry, not asset observation, and
 * freshness stays explicitly unverified.
 */
export function adaptAfiProof(payload: AfiProofPayload, params: AfiProofParams): AdapterResult {
  if (payload.symbol !== params.symbol) {
    throw new Error(`AFI proof symbol ${payload.symbol} does not match configured symbol ${params.symbol}`);
  }
  const totalReserves = Number(payload.totalReserves);
  const totalLiabilities = Number(payload.totalLiabilities);
  const collateralRatio = Number(payload.collateralRatio);
  if (!Number.isFinite(totalReserves) || totalReserves < 0
    || !Number.isFinite(totalLiabilities) || totalLiabilities < 0
    || !Number.isFinite(collateralRatio)) {
    throw new Error("AFI proof totals are not finite non-negative numbers");
  }
  const verifiedReserves = Number(payload.proof.verifiedTotals.totalReserves);
  const verifiedLiabilities = Number(payload.proof.verifiedTotals.totalLiabilities);
  if (!Number.isFinite(verifiedReserves) || !Number.isFinite(verifiedLiabilities)) {
    throw new Error("AFI proof verifiedTotals are not finite numbers");
  }
  if (verifiedReserves !== totalReserves || verifiedLiabilities !== totalLiabilities) {
    throw new Error(
      `AFI proof verifiedTotals (${verifiedReserves} / ${verifiedLiabilities}) disagree with the envelope totals (${totalReserves} / ${totalLiabilities})`,
    );
  }
  if (totalLiabilities <= 0) {
    throw new Error(`AFI proof reports non-positive total liabilities (${totalLiabilities})`);
  }

  const ratioPct = (totalReserves / totalLiabilities) * 100;
  if (Math.abs(collateralRatio - ratioPct) > 0.01) {
    throw new Error(
      `AFI collateralRatio ${collateralRatio} disagrees with reserves/liabilities ${ratioPct.toFixed(4)}`,
    );
  }

  const warnings = [
    reserveInfoWarning(
      "opaque-reserve-basket",
      "The AFI proof verifies aggregate reserve and liability totals only; constituent assets, "
      + "custodians and the as-of dates of the underlying assets are undisclosed commitments.",
    ),
  ];
  if (!payload.active) {
    warnings.push(
      reserveDegradedWarning(
        "proof-marked-inactive",
        `AFI marks the ${payload.symbol} proof as inactive; the published totals are retained for ratio telemetry only.`,
      ),
    );
  }
  if (totalReserves < totalLiabilities) {
    warnings.push(
      reserveDegradedWarning(
        "reserve-undercollateralized",
        `AFI proof reports reserves $${totalReserves.toLocaleString("en-US")} below liabilities `
        + `$${totalLiabilities.toLocaleString("en-US")} (ratio ${ratioPct.toFixed(4)}%).`,
      ),
    );
  }

  return {
    slices: [{
      name: "Institutional credit and market-neutral fund basket",
      sourceKey: `${ADAPTER_KEY}:aggregate`,
      pct: 100,
      risk: "high",
      assetClass: "other",
      issuerOrObligor: "Undisclosed rwaUSDi private-pool borrowers, funds, and strategy counterparties",
    }],
    warnings,
    metadata: {
      totalReserveUsd: totalReserves,
      totalLiabilitiesUsd: totalLiabilities,
      collateralizationRatio: totalReserves / totalLiabilities,
      unknownExposurePct: 100,
      ...unverifiedFreshnessMetadata(
        "afi-proof-generation",
        `proof ${payload.proof.metadata.proofId} generated ${isoFromEpochMs(payload.proof.metadata.generatedAtEpoch)}; `
        + "the AFI envelope does not disclose the as-of dates of the underlying reserve assets",
      ),
      details: {
        proofId: payload.proof.metadata.proofId,
        feedId: payload.proof.metadata.feedId,
        version: payload.proof.metadata.version,
        keyVersion: payload.proof.metadata.keyVersion,
        generatedAtIso: isoFromEpochMs(payload.proof.metadata.generatedAtEpoch),
        totalsTimestampIso: isoFromEpochMs(payload.timestampInMs),
        active: payload.active,
        collateralRatioPct: collateralRatio,
        opaqueBasket: true,
        hasZkProofs: typeof payload.proof.zkProofs === "object" && payload.proof.zkProofs !== null,
        hasMerkleProof: typeof payload.proof.merkleProof === "object" && payload.proof.merkleProof !== null,
        hasTeeAttestation: typeof payload.proof.teeAttestation === "object" && payload.proof.teeAttestation !== null,
      },
    },
  };
}

export async function fetchAfiProofReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, ADAPTER_KEY);
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const payload = await fetchJsonWithRetry<unknown>(input.url, signal, REQUEST_TIMEOUT_MS, ctx);
  return adaptAfiProof(AfiProofPayloadSchema.parse(payload), params);
}
