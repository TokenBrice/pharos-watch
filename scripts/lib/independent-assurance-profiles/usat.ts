import { AMOUNT, type CompilerProfile } from "./shared";

function usatScheduleAmountPattern(schedule: string, label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- schedule/label are fixed literals from the reviewed extraction tables below.
  return new RegExp(`${schedule}[\\s\\S]*?^\\s*${label}\\s+\\$?${AMOUNT}\\s*$`, "im");
}

export const PROFILE: CompilerProfile = {
  product: "USAT",
  profile: "usat-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usat-reserve-attestations",
  reportUrl: "https://learn.anchorage.com/07.31.26_USAT-Stablecoin-Attestation-Report-signed.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:59:59Z",
  reportTimeZone: "UTC",
  reportIssuedAt: "2026-08-28T23:59:00Z",
  attestor: "Deloitte & Touche LLP",
  attestorIdentification: {
    method: "reviewed-inference",
    evidence: [
      "The signed report's letterhead image is byte-identical (md5) to the Deloitte & Touche LLP letterhead published in the firm's other reviewed reports.",
      "The Anchorage attestation page and the report body describe the examiner only as a Big Four accounting firm and never print the firm name in extractable text.",
    ],
    reReviewTrigger: "Re-review if the letterhead image bytes change, the Big Four wording is replaced with a named firm, or any extractable text begins naming the attestor directly.",
  },
  engagement: "Independent accountant's examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    { code: "cash", label: "Cash", pattern: usatScheduleAmountPattern("Schedule II:", "Cash") },
    { code: "reverse-repo", label: "Reverse repurchase agreements collateralized by U.S. Treasury securities, at fair value", pattern: usatScheduleAmountPattern("Schedule II:", "Reverse repurchase agreements collateralized by U\\.S\\. Treasury securities,") },
  ],
  liabilityRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "ethereum", label: "Ethereum USAT redeemable tokens", pattern: /^\s*f\.\s+Total USAT redeemable tokens\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "celo", label: "Celo USAT redeemable tokens", pattern: /^\s*f\.\s+Total USAT redeemable tokens\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
  ],
  requiredText: [
    { label: "AICPA attestation standards", pattern: /attestation standards established by the American[\s\S]*Institute of Certified Public Accountants[\s\S]*AICPA/i },
    { label: "USAT July 2026 report date", pattern: /July 31, 2026[\s\S]*11:59:59 PM Coordinated Universal Time/i },
    { label: "favorable examination conclusion", pattern: /fairly stated, in all[\s\S]{0,120}?material respects/i },
    { label: "independent accountant's report", pattern: /Independent Accountant(?:’|')s Report/i },
    { label: "USAT Schedule I", pattern: /Schedule I: Total USAT Natively Minted Tokens/i },
    { label: "USAT Schedule II", pattern: /Schedule II: Composition of Reserve Assets/i },
    { label: "USAT Schedule III", pattern: /Schedule III: Comparison Between the Reserve Assets/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "USAT redeemable token total", expected: "175245527", pattern: /^\s*Total USAT redeemable tokens outstanding\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    { label: "USAT reserve asset total", expected: "175906606", pattern: usatScheduleAmountPattern("Schedule II:", "Total") },
  ],
  reportedAssetTotal: "175906606",
  computedAssetTotal: "175906606",
  reportedLiabilityTotal: "175245527",
};
