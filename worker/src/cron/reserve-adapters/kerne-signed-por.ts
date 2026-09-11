import { getCanonicalReserveAssetRisk } from "@shared/lib/reserve-asset-risk";
import {
  parseLiveReserveAdapterParams,
  type LiveReserveAdapterParamsByKey,
} from "@shared/lib/live-reserve-adapters";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReserveWarning, LiveReservesConfig } from "@shared/types/live-reserves";
import { hexToBytes, keccak256, recoverAddress } from "viem/utils";
import { encodeBalanceOfCallData } from "../../lib/evm-selectors";
import type { EvmMulticall3Result } from "../../lib/evm-rpc";
import { sha256Hex } from "../../lib/hash";
import type { AdapterContext, AdapterResult } from "./types";
import {
  decimalNumberFromBigInt,
  fetchJsonAdapterInput,
  fetchOnchainMulticall3,
  reserveDegradedWarning,
  slicesFromValues,
  verifiedFreshnessMetadata,
  type OnchainMulticall3Call,
} from "./helpers";

const ADAPTER_KEY = "kerne-signed-por";

// Canonical Circle USDC on Base: the sole reserve asset held by kUSD's three
// Peg Stability Module contracts.
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_DECIMALS = 6;

// The signed `psm_usdc_reserve` is a 6-decimal float. The on-chain sum is
// exact; a divergence beyond half a cent is a real measurement gap rather than
// sub-cent rounding of the published figure.
const ONCHAIN_MATCH_TOLERANCE_USD = 0.01;

type KerneSignedPorParams = LiveReserveAdapterParamsByKey[typeof ADAPTER_KEY];

interface KerneSignedPorPayload {
  schema_version?: number;
  signer?: string;
  signature?: string;
  attestation_hash?: string;
  signed_payload_canonical?: string;
}

interface KerneSignedCanonical {
  schema_version?: number;
  timestamp?: number;
  psm_usdc_reserve?: number;
  outstanding_kusd?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  throw new Error(`${ADAPTER_KEY} payload ${label} is not a non-empty string`);
}

function parseFiniteNonNegative(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  throw new Error(`${ADAPTER_KEY} payload ${label} is not a finite non-negative number: ${String(value)}`);
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  throw new Error(`${ADAPTER_KEY} signed payload has an unreadable timestamp`);
}

/** EIP-191 personal_sign message hash over a 32-byte digest. */
function eip191DigestHash(digestHex: string): `0x${string}` {
  const digest = hexToBytes(digestHex as `0x${string}`);
  const prefix = new TextEncoder().encode(`\u0019Ethereum Signed Message:\n${digest.length}`);
  const message = new Uint8Array(prefix.length + digest.length);
  message.set(prefix, 0);
  message.set(digest, prefix.length);
  return keccak256(message);
}

/**
 * Verifies the issuer's EIP-191 signature. Fails closed: the canonical bytes
 * must rehash to the published `attestation_hash`, and the signature over that
 * digest must recover the pinned signer. A mismatch is an unverifiable feed,
 * never a degraded observation.
 */
async function verifySignedAttestation(
  payload: KerneSignedPorPayload,
  pinnedSigner: string,
): Promise<{ canonical: KerneSignedCanonical; attestationHash: string }> {
  const canonicalField = requireString(payload.signed_payload_canonical, "signed_payload_canonical");
  const signature = requireString(payload.signature, "signature");
  const attestationHash = requireString(payload.attestation_hash, "attestation_hash").toLowerCase();

  const recomputed = `0x${await sha256Hex(canonicalField)}`;
  if (recomputed !== attestationHash) {
    throw new Error(`${ADAPTER_KEY} canonical bytes do not rehash to attestation_hash`);
  }

  const recovered = await recoverAddress({
    hash: eip191DigestHash(attestationHash),
    signature: signature as `0x${string}`,
  }).catch(() => null);
  if (recovered == null || recovered.toLowerCase() !== pinnedSigner.toLowerCase()) {
    throw new Error(`${ADAPTER_KEY} signature does not recover the pinned signer`);
  }

  let canonical: KerneSignedCanonical;
  try {
    canonical = JSON.parse(canonicalField) as KerneSignedCanonical;
  } catch {
    throw new Error(`${ADAPTER_KEY} signed_payload_canonical is not valid JSON`);
  }

  return { canonical, attestationHash };
}

function balanceFromMulticallResult(result: EvmMulticall3Result | undefined): bigint | null {
  if (!result || !result.success) return null;
  try {
    return BigInt(result.returnData);
  } catch {
    return null;
  }
}

interface AdaptInput {
  canonical: KerneSignedCanonical;
  params: KerneSignedPorParams;
  onchainUsdcRaw: bigint | null;
}

export function adaptKerneSignedPor(input: AdaptInput): AdapterResult {
  const { canonical, params } = input;

  const timestamp = parseTimestamp(canonical.timestamp);
  const psmUsdcReserve = parseFiniteNonNegative(canonical.psm_usdc_reserve, "psm_usdc_reserve");
  const outstandingKusd = parseFiniteNonNegative(canonical.outstanding_kusd, "outstanding_kusd");
  if (outstandingKusd === 0) {
    throw new Error(`${ADAPTER_KEY} signed payload has zero outstanding_kusd`);
  }

  const warnings: LiveReserveWarning[] = [];

  if (input.onchainUsdcRaw == null) {
    warnings.push(reserveDegradedWarning(
      "kerne-onchain-read-failed",
      `PSM USDC balance could not be read on-chain (balanceOf failed); keeping signed value $${psmUsdcReserve.toFixed(2)}`,
    ));
  } else {
    const onchainUsd = decimalNumberFromBigInt(input.onchainUsdcRaw, USDC_DECIMALS);
    if (Math.abs(onchainUsd - psmUsdcReserve) > ONCHAIN_MATCH_TOLERANCE_USD) {
      warnings.push(reserveDegradedWarning(
        "kerne-onchain-mismatch",
        `On-chain PSM USDC balance $${onchainUsd.toFixed(6)} differs from signed psm_usdc_reserve $${psmUsdcReserve.toFixed(6)}; keeping the signed value`,
      ));
    }
  }

  const collateralizationRatio = psmUsdcReserve / outstandingKusd;
  if (collateralizationRatio < 1) {
    warnings.push(reserveDegradedWarning(
      "reserve-undercollateralized",
      `Signed PSM USDC reserve $${psmUsdcReserve.toFixed(2)} is below outstanding kUSD $${outstandingKusd.toFixed(2)}`,
    ));
  }

  const sliceInputs: Array<{
    value: number;
    sourceKey: string;
    name: string;
    risk: ReserveSlice["risk"];
    coinId: string;
    depType: ReserveSlice["depType"];
    blacklistable: boolean;
  }> = [
    {
      sourceKey: `${ADAPTER_KEY}:psm-usdc`,
      name: "USDC held 1:1 in the on-chain Peg Stability Module",
      value: psmUsdcReserve,
      risk: getCanonicalReserveAssetRisk("USDC") ?? "low",
      coinId: "usdc-circle",
      depType: "collateral",
      blacklistable: true,
    },
  ];

  return {
    slices: slicesFromValues(sliceInputs),
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(timestamp),
      totalReserveUsd: psmUsdcReserve,
      supplyUsd: outstandingKusd,
      collateralizationRatio,
      details: {
        schemaVersion: canonical.schema_version,
        signer: params.signerAddress,
        psmCount: params.psmAddresses.length,
        ...(input.onchainUsdcRaw != null
          ? { onchainUsdc: decimalNumberFromBigInt(input.onchainUsdcRaw, USDC_DECIMALS) }
          : {}),
      },
    },
  };
}

export async function fetchKerneSignedPorReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const payload = await fetchJsonAdapterInput<KerneSignedPorPayload>(
    config,
    ADAPTER_KEY,
    signal,
    12_000,
    ctx,
  );

  const { canonical } = await verifySignedAttestation(payload, params.signerAddress);

  // Cross-check the PSM USDC balance on Base in the same run. One Multicall3
  // aggregate reads every pinned PSM's balanceOf; each call is allowFailure so
  // a reverting leg degrades rather than aborting the whole read.
  const calls: OnchainMulticall3Call[] = params.psmAddresses.map((address, index) => ({
    label: `psm-${index}-balance`,
    contract: USDC_BASE,
    data: encodeBalanceOfCallData(address),
    allowFailure: true,
  }));
  const results = await fetchOnchainMulticall3({ chain: "base", calls, signal, ctx });
  let onchainUsdcRaw: bigint | null = null;
  if (results != null && results.length === params.psmAddresses.length) {
    let sum = 0n;
    let complete = true;
    for (const result of results) {
      const balance = balanceFromMulticallResult(result);
      if (balance == null) {
        complete = false;
        break;
      }
      sum += balance;
    }
    if (complete) onchainUsdcRaw = sum;
  }

  return adaptKerneSignedPor({ canonical, params, onchainUsdcRaw });
}
