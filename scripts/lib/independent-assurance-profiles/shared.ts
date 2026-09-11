import type { IndependentAssuranceManifest, IndependentAssuranceProduct } from "@shared/lib/independent-assurance";

export const AMOUNT = "([0-9][0-9,]*(?:\\.[0-9]+)?)";

export interface CompilerProfile {
  product: IndependentAssuranceProduct;
  profile: string;
  officialIndexUrl: string;
  reportUrl: string;
  reportDate: string;
  reportAsOf: string;
  reportTimeZone: string;
  attestor: string;
  attestorIdentification?: NonNullable<IndependentAssuranceManifest["attestorIdentification"]>;
  engagement: string;
  conclusion: IndependentAssuranceManifest["conclusion"];
  unit: IndependentAssuranceManifest["unit"];
  assetRows: Array<{ code: string; label: string; pattern: RegExp }>;
  liabilityRows: Array<{ code: string; label: string; pattern: RegExp }>;
  adjustments?: Array<{ code: string; label: string; pattern: RegExp; treatment: string }>;
  requiredText: Array<{ label: string; pattern: RegExp }>;
  rejectedText: Array<{ label: string; pattern: RegExp }>;
  reportedTotals: Array<{ label: string; expected: string; pattern: RegExp }>;
  reportedAssetTotal: string;
  computedAssetTotal: string;
  reportedLiabilityTotal: string;
  reportIssuedAt?: string;
  /** Normalizes a raw extracted amount (e.g. Brazilian "R$ 231.887.240,50") to a
   *  decimal string. Defaults to the compiler's US-style `$`/`,` stripping. */
  normalizeAmount?: (raw: string) => string;
}

export function linePattern(label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- labels are fixed literals from the reviewed extraction tables below.
  return new RegExp(`^\\s*${label}\\d*\\s+\\$?${AMOUNT}\\s*$`, "im");
}
