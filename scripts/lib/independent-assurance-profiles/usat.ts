import { scheduleAmountPattern, type CompilerProfile } from "./shared";


export const PROFILE: CompilerProfile = {
  product: "USAT",
  profile: "usat-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usat-reserve-attestations",
  reportUrl: "https://learn.anchorage.com/09.30.26_USAT-Stablecoin-Attestation-Report-signed.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:59Z",
  reportTimeZone: "UTC",
  reportIssuedAt: "2026-10-26T23:59:00Z",
  attestor: "Deloitte & Touche LLP",
  attestorIdentification: {
    method: "reviewed-inference",
    evidence: [
      "The September report's rendered first page names Deloitte & Touche LLP on the letterhead and bears its handwritten signature; reviewed visually on 2026-11-03.",
      "The letterhead is an image and the examiner name is absent from the Poppler text extraction.",
    ],
    reReviewTrigger: "Re-review the rendered letterhead and signature for each new report or if the examiner identity changes.",
  },
  engagement: "Independent accountant's examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    { code: "cash", label: "Cash", pattern: scheduleAmountPattern("Schedule II:", "Cash") },
    { code: "reverse-repo", label: "Reverse repurchase agreements collateralized by U.S. Treasury securities, at fair value", pattern: scheduleAmountPattern("Schedule II:", "Reverse repurchase agreements collateralized by U\\.S\\. Treasury securities,") },
  ],
  liabilityRows: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "ethereum", label: "Ethereum USAT redeemable tokens", pattern: /^\s*f\.\s+Total USAT redeemable tokens\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "celo", label: "Celo USAT redeemable tokens", pattern: /^\s*f\.\s+Total USAT redeemable tokens\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im },
  ],
  requiredText: [
    { label: "AICPA attestation standards", pattern: /attestation standards established by the American[\s\S]*Institute of Certified Public Accountants[\s\S]*AICPA/i },
    { label: "USAT September 2026 report date", pattern: /September 30, 2026, at 11:59:59 PM Coordinated Universal Time/i },
    { label: "favorable examination conclusion", pattern: /fairly stated, in all[\s\S]{0,120}?material respects/i },
    { label: "independent accountant's report", pattern: /Independent Accountant(?:’|')s Report/i },
    { label: "USAT Schedule I", pattern: /Schedule I: Total USAT Natively Minted Tokens/i },
    { label: "USAT Schedule II", pattern: /Schedule II: Composition of Reserve Assets/i },
    { label: "USAT Schedule III", pattern: /Schedule III: Comparison Between the Reserve Assets/i },
    { label: "USAT accountant signature date", pattern: /October 26, 2026/ },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "USAT redeemable token total", expected: "176216064", pattern: /^\s*Total USAT redeemable tokens outstanding\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    { label: "USAT reserve asset total", expected: "176877250", pattern: scheduleAmountPattern("Schedule II:", "Total") },
  ],
  reportedAssetTotal: "176877250",
  computedAssetTotal: "176877250",
  reportedLiabilityTotal: "176216064",
};
