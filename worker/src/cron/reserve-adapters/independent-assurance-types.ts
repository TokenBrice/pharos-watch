import type {
  IndependentAssuranceManifest,
  IndependentAssuranceProduct,
  IndependentAssuranceReconciliationOptions,
} from "@shared/lib/independent-assurance";
import type { ReserveSlice } from "@shared/types/reserves";
import type { AdapterContext } from "./types";

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
  /** May also report a newer unreviewed entry it detected outside the returned HTML. */
  prepareIndexHtml?: (html: string, signal: AbortSignal, ctx?: AdapterContext, manifest?: IndependentAssuranceManifest) =>
    Promise<string | { html: string; newerUnreviewedReport: NewerUnreviewedReport | null }>;
  /**
   * Header overrides for the official index fetch. Publisher WAFs disagree
   * about crawler user agents (Fidelity Digital Assets 403s the shared index
   * UA), so a profile whose index host rejects the default supplies its own.
   */
  indexHeaders?: Record<string, string>;
  /** JSON-index publishers (e.g. Gemini's Contentful attestation collection):
   *  verify the raw index body in place of the HTML candidate/date checks.
   *  The hook MUST retain the equivalents: the exact reviewed report URL stays
   *  uniquely listed at its reviewed date, and any newer entry is returned as
   *  a newer unreviewed report rather than admitted. */
  verifyIndexJson?: (json: string, manifest: IndependentAssuranceManifest, signal: AbortSignal, ctx?: AdapterContext) => Promise<NewerUnreviewedReport | null | void>;
}

/** Identity of a newer official-index entry that has not been reviewed. */
export interface NewerUnreviewedReport {
  reportDate?: string;
  reportUrl?: string;
}
