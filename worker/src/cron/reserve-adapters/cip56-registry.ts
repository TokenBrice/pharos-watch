import { z } from "zod";
import { parseUnits } from "viem/utils";
import type { IssuerNativeLiabilityScope } from "@shared/types/live-reserve-adapter-declarations";
import { fetchJsonWithRetry } from "./request";
import type { AdapterContext } from "./types";

export type Cip56RegistryInstrumentSource =
  NonNullable<IssuerNativeLiabilityScope["included"][number]["registry"]>;

export interface Cip56RegistrySupplyRead {
  raw: bigint;
  decimals: number;
  /** Unix seconds of the registry's last-computed clock. */
  observedAt: number;
  /** The registry's exact `totalSupplyAsOf` text. */
  asOf: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
/** A registry clock may lead the run clock by at most this much transport/clock skew. */
const MAX_FUTURE_CLOCK_SKEW_SEC = 300;

/**
 * The CIP-56 token metadata `Instrument` object. Required fields follow the
 * token-metadata-v1 OpenAPI schema; `totalSupply` and `totalSupplyAsOf` are
 * optional in the standard, so their presence is a reviewed admission gate for
 * a liability read.
 */
const CIP56_INSTRUMENT_SCHEMA = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    symbol: z.string().trim().min(1),
    totalSupply: z.string().trim().min(1).optional(),
    totalSupplyAsOf: z.iso.datetime({ offset: true }).optional(),
    decimals: z.number().int().min(0).max(10),
    supportedApis: z.record(z.string(), z.number().int()),
  })
  .passthrough();

/**
 * Read one instrument's registry-reported total supply. The value is the
 * registry's own sum of active Holding amounts, not an independently
 * verifiable ledger read: callers must carry the registry source and the
 * `totalSupplyAsOf` clock into provenance. A missing, future-dated or older
 * than `maxSupplyAgeSec` clock fails before admission.
 */
export async function fetchCip56RegistrySupply(
  source: Cip56RegistryInstrumentSource,
  options: { signal: AbortSignal; nowSec: number; ctx?: AdapterContext },
): Promise<Cip56RegistrySupplyRead> {
  const payload = await fetchJsonWithRetry<unknown>(source.url, options.signal, REQUEST_TIMEOUT_MS, options.ctx, {
    headers: { Accept: "application/json" },
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  const parsed = CIP56_INSTRUMENT_SCHEMA.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`CIP-56 registry instrument schema invalid: ${detail}`);
  }
  const instrument = parsed.data;
  if (instrument.id !== source.instrumentId) {
    throw new Error(`CIP-56 registry instrument id ${instrument.id} does not match ${source.instrumentId}`);
  }
  if (instrument.symbol !== source.symbol) {
    throw new Error(`CIP-56 registry instrument symbol ${instrument.symbol} does not match ${source.symbol}`);
  }
  if (instrument.decimals !== source.decimals) {
    throw new Error(`CIP-56 registry instrument decimals ${instrument.decimals} do not match ${source.decimals}`);
  }
  if (instrument.totalSupply == null) {
    throw new Error("CIP-56 registry instrument omits optional totalSupply");
  }
  if (instrument.totalSupplyAsOf == null) {
    throw new Error("CIP-56 registry instrument omits optional totalSupplyAsOf");
  }
  const asOfMs = Date.parse(instrument.totalSupplyAsOf);
  if (!Number.isFinite(asOfMs)) {
    throw new Error("CIP-56 registry totalSupplyAsOf is not a valid instant");
  }
  const observedAt = Math.floor(asOfMs / 1000);
  const ageSec = options.nowSec - observedAt;
  if (ageSec > source.maxSupplyAgeSec) {
    throw new Error(
      `CIP-56 registry totalSupplyAsOf is ${ageSec}s old (max ${source.maxSupplyAgeSec}s)`,
    );
  }
  if (ageSec < -MAX_FUTURE_CLOCK_SKEW_SEC) {
    throw new Error(`CIP-56 registry totalSupplyAsOf is ${-ageSec}s in the future`);
  }

  let raw: bigint;
  try {
    raw = parseUnits(instrument.totalSupply, instrument.decimals);
  } catch {
    throw new Error("CIP-56 registry totalSupply does not match instrument decimals");
  }
  if (raw < 0n) {
    throw new Error("CIP-56 registry totalSupply is negative");
  }
  return {
    raw,
    decimals: instrument.decimals,
    observedAt,
    asOf: instrument.totalSupplyAsOf,
  };
}
