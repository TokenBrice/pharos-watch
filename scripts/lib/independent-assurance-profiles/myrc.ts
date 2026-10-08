import type { CompilerProfile } from "./shared";

// The examined account total and the printed breakdown differ by MYR 0.03.
// Keep both values; the runtime and offline reconciler share the same narrow tolerance.
export const PROFILE: CompilerProfile = {
  product: "MYRC",
  profile: "myrc-v1",
  officialIndexUrl: "https://api.blox.my/blox-admin/attestations",
  reportUrl: "https://cdn.blox.my/attestations/2026/Blox%20Attestation%20Report-2026-08-August.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:00+08:00",
  reportTimeZone: "GMT+8 (as printed in the report)",
  attestor: "Tommy Ung & Partners PLT (AF002378)",
  engagement: "ISAE 3000 (Revised) reasonable assurance examination",
  conclusion: "unmodified",
  unit: "MYR",
  assetRows: [
    { code: "cash", label: "MYR cash at undisclosed Malaysian banks", pattern: /^Cash[ \t]+([\d,]+\.\d{2})[ \t]+66\.68%/m },
    { code: "halogen-myr-liquid-fund", label: "Halogen Shariah MYR Liquid Fund", pattern: /^Halogen Shariah MYR Liquid[ \t]+([\d,]+\.\d{2})[ \t]+33\.32%\s*\nFund/m },
  ],
  liabilityRows: [
    { code: "net-circulation", label: "MYRC in circulation under the examined approved-blockchain criterion", pattern: /^[ \t]*MYRC in Circulation[ \t]+([\d,]+\.\d{2})[ \t]*$/m },
  ],
  adjustments: [
    {
      code: "authorized-not-issued",
      label: "Tokens authorized but not issued on MYRC Approved Blockchain",
      pattern: /Not Issued as reported on MYRC Approved Blockchain \(([\d,]+\.\d{2})\)/,
      kind: "excluded-circulation",
      treatment: "Already excluded from approved-blockchain gross supply 6365298.65 to obtain examined net circulation 1800903.74; do not deduct again.",
    },
  ],
  requiredText: [
    { label: "examiner", pattern: /TOMMY UNG & PARTNERS PLT \(AF 002378\)/ },
    { label: "MYRC subject", pattern: /Malaysian Ringgit Coin \(“MYRC”\) Reserve Report/ },
    { label: "examined instant", pattern: /31 August 2026 at 11:59 PM GMT\+8/ },
    { label: "ISAE3000 engagement", pattern: /Standard on Assurance Engagements 3000 \(Revised\)/ },
    { label: "reasonable assurance", pattern: /reasonable assurance engagement/ },
    { label: "unmodified opinion", pattern: /In our opinion,[\s\S]*?Company as at 31 August 2026 is fairly stated,[\s\S]*?in all material respects\./ },
    { label: "signature date only", pattern: /Malaysia\s+29 September 2026/ },
    { label: "approved-chain gross supply criterion", pattern: /total MYRC supply on MYRC Approved\s+Blockchain at the Report Date \(6,365,298\.65\) less/ },
    { label: "restricted reliance caveat", pattern: /This report is made solely to the Company[\s\S]*?We do not assume responsibility to any other person/ },
  ],
  rejectedText: [
    { label: "unfavorable or non-assurance opinion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for|agreed-upon procedures|not an assurance engagement/i },
  ],
  reportedTotals: [
    { label: "asserted reserve account total", expected: "1800903.74", pattern: /^[ \t]*Total[ \t]+Malaysian[ \t]+Ringgit[ \t]+\(MYR\)[ \t]+([\d,]+\.\d{2})/m },
    { label: "printed breakdown total", expected: "1800903.77", pattern: /^Total[ \t]+([\d,]+\.\d{2})[ \t]+100\.00%/m },
    { label: "net circulation", expected: "1800903.74", pattern: /^[ \t]*MYRC in Circulation[ \t]+([\d,]+\.\d{2})[ \t]*$/m },
    { label: "excluded authorized tokens", expected: "4564394.91", pattern: /Not Issued as reported on MYRC Approved Blockchain \(([\d,]+\.\d{2})\)/ },
  ],
  reportedAssetTotal: "1800903.74",
  computedAssetTotal: "1800903.77",
  reportedLiabilityTotal: "1800903.74",
};
