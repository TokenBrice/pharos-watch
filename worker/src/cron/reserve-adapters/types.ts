import type {
  IndependentAssuranceManifest,
  IndependentAssuranceProduct,
  IndependentAssuranceReconciliationOptions,
} from "@shared/lib/independent-assurance";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReserveAdapterDescriptor } from "@shared/types/live-reserve-adapter-declarations";
import type {
  LiveReserveAdapterKey,
  LiveReserveSnapshotMetadata,
  LiveReserveWarning,
  LiveReservesConfig,
} from "@shared/types/live-reserves";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import type { DwellirNativeCapability } from "../../lib/dwellir-native";
import type { AdapterIoLimiter } from "./concurrency";

/** Context passed from the cron to adapters that need worker infrastructure. */
export interface AdapterContext {
  db?: D1Database;
  etherscanApiKey?: string;
  alchemyApiKey?: string;
  trongridApiKey?: string;
  m0ApiKey?: string;
  chainRpcs?: Map<string, ChainRpcConfig>;
  dwellirNative?: DwellirNativeCapability;
  nowSec?: number;
  observedBlock?: { chain: string; number: number; timestamp: number };
  requestCache?: Map<string, Promise<unknown>>;
  /** Request helper observes retained and pending hits explicitly; never infer from Map operations. */
  onRequestCache?: (event: { key: string; hit: boolean; promise: Promise<unknown> }) => void;
  ioLimiter?: AdapterIoLimiter;
  abortSignal?: AbortSignal;
}

interface AssuranceSliceClassification {
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  assetClass?: ReserveSlice["assetClass"];
  issuerOrObligor?: string;
  riskFactors?: ReserveSlice["riskFactors"];
  liquidityHorizon?: ReserveSlice["liquidityHorizon"];
}

export interface IndependentAssuranceProfile {
  adapterName: string;
  product: IndependentAssuranceProduct;
  profile: string;
  requiredAssetCodes: readonly string[];
  classifications: Readonly<Record<string, AssuranceSliceClassification>>;
  reconciliation?: IndependentAssuranceReconciliationOptions;
  isReportCandidate: (href: string, text: string) => boolean;
  reportDateFromCandidate: (href: string, text: string) => string | null;
  prepareIndexHtml?: (html: string, signal: AbortSignal, ctx?: AdapterContext) => Promise<string>;
  /**
   * Header overrides for the official index fetch. Publisher WAFs disagree
   * about crawler user agents (Fidelity Digital Assets 403s the shared index
   * UA), so a profile whose index host rejects the default supplies its own.
   */
  indexHeaders?: Record<string, string>;
  /** JSON-index publishers (e.g. Gemini's Contentful attestation collection):
   *  verify the raw index body in place of the HTML candidate/date checks.
   *  The hook MUST retain the equivalents: exact reviewed report URL, a unique
   *  newest entry, and fail-closed on any newer unreviewed entry. */
  verifyIndexJson?: (json: string, manifest: IndependentAssuranceManifest, signal: AbortSignal, ctx?: AdapterContext) => Promise<void>;
}

export interface AdapterResult {
  slices: ReserveSlice[];
  warnings?: LiveReserveWarning[];
  metadata?: LiveReserveSnapshotMetadata;
}

export type AdapterFn = (
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) => Promise<AdapterResult>;

/**
 * Projection of the shared declaration plus the Worker-only fetch function.
 * Projecting rather than re-declaring keeps fields such as
 * `redemptionTelemetry.capacityParamsGated` visible to the Worker as soon as
 * the declaration gains them.
 */
export type ReserveAdapterDefinition = Pick<
  LiveReserveAdapterDescriptor,
  "sourceModel" | "evidenceClass" | "sharedSourceMode" | "redemptionTelemetry" | "validation"
> & {
  key: LiveReserveAdapterKey;
  fetch: AdapterFn;
};
