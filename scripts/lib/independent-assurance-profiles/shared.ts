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
  nativeQuantityBasis?: IndependentAssuranceManifest["nativeQuantityBasis"];
  assetRows: Array<{ code: string; label: string; pattern: RegExp }>;
  liabilityRows: Array<{ code: string; label: string; pattern: RegExp }>;
  adjustments?: Array<{ code: string; label: string; pattern: RegExp; treatment: string } & (
    { kind: "excluded-circulation" } | { alreadyNettedIntoAssets: true }
  )>;
  requiredText: Array<{ label: string; pattern: RegExp }>;
  rejectedText: Array<{ label: string; pattern: RegExp }>;
  reportedTotals: Array<{ label: string; expected: string; pattern: RegExp }>;
  reportedAssetTotal: string;
  computedAssetTotal: string;
  reportedLiabilityTotal: string;
  reportIssuedAt?: string;
  /** Image-only rows are transcribed only for the exact reviewed artifact. */
  reviewedImageExtraction?: {
    reportSha256: string;
    reportByteLength: number;
    normalizedTextSha256: string;
    pageCount: number;
    tool: string;
    text: string;
  };
  /** Normalizes a raw extracted amount (e.g. Brazilian "R$ 231.887.240,50") to a
   *  decimal string. Defaults to the compiler's US-style `$`/`,` stripping. */
  normalizeAmount?: (raw: string) => string;
}

export function linePattern(label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- labels are fixed literals from the reviewed extraction tables below.
  return new RegExp(`^\\s*${label}\\d*\\s+\\$?${AMOUNT}\\s*$`, "im");
}

export function scheduleAmountPattern(schedule: string, label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- schedule/label are fixed literals from reviewed extraction tables.
  return new RegExp(`${schedule}[\\s\\S]*?^\\s*${label}\\s+\\$?${AMOUNT}\\s*$`, "im");
}

export function prepareAssuranceExtractionText(
  profile: CompilerProfile,
  artifact: { reportSha256: string; reportByteLength: number; normalizedTextSha256: string; pageCount: number; text: string },
): string {
  const reviewed = profile.reviewedImageExtraction;
  if (!reviewed) return artifact.text;
  for (const key of ["reportSha256", "reportByteLength", "normalizedTextSha256", "pageCount"] as const) {
    if (artifact[key] !== reviewed[key]) {
      throw new Error(`offline assurance compiler: reviewed image extraction ${key} mismatch; re-review the report`);
    }
  }
  return `${artifact.text}\n${reviewed.text}`;
}
