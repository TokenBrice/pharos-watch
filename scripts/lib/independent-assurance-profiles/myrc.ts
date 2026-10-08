import { type CompilerProfile } from "./shared";

/** August report retained for offline identity verification, not fresh activation. */
export const PROFILE: CompilerProfile = {
  product: "MYRC",
  profile: "myrc-v1",
  officialIndexUrl: "https://api.blox.my/blox-admin/attestations",
  reportUrl: "https://cdn.blox.my/attestations/2026/Blox%20Attestation%20Report-2026-08-August.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:00+08:00",
  reportTimeZone: "GMT+8 (as printed in the report)",
  attestor: "Tommy Ung & Partners PLT (AF 002378)",
  engagement: "ISAE 3000 (Revised) reasonable assurance on MYRC Reserve Information",
  conclusion: "unmodified",
  unit: "MYR",
  nativeQuantityBasis: {
    reserveUnit: { kind: "currency", unit: "MYR" },
    supplyToken: "MYRC",
    nominalValuePerToken: 1,
    reviewedAt: "2026-10-08",
    evidenceRef: "MYRC Reserve Report: MYR-denominated fair value meets or exceeds MYRC in circulation at 31 August 2026 11:59 PM GMT+8; circulation is approved-chain supply less authorized-but-not-issued tokens.",
  },
  assetRows: [
    { code: "cash", label: "MYR cash at Malaysian banks", pattern: /^\s*Cash\s+([0-9][0-9,]*\.[0-9]{2})\s+66\.68%\s*$/im },
    { code: "halogen-myr-liquid-fund", label: "Halogen Shariah MYR Liquid Fund", pattern: /^\s*Halogen Shariah MYR Liquid\s+([0-9][0-9,]*\.[0-9]{2})\s+33\.32%\s*\nFund\b/im },
  ],
  liabilityRows: [
    { code: "circulation", label: "MYRC circulation after authorized-but-not-issued exclusion", pattern: /MYRC in Circulation\s*=\s*([0-9][0-9,]*\.[0-9]{2})\s*MYRC/ },
  ],
  requiredText: [
    { label: "independent examiner", pattern: /TOMMY UNG & PARTNERS PLT\s*\(AF 002378\)/i },
    { label: "ISAE 3000 Revised reasonable assurance", pattern: /Standard on Assurance Engagements 3000\s*\(Revised\)/i },
    { label: "examined instant", pattern: /31 August 2026 at 11:59 PM GMT\+8/i },
    { label: "favorable full opinion", pattern: /In our opinion,[\s\S]*?Company as at 31 August 2026 is fairly stated,[\s\S]*?in all material respects\./i },
    { label: "circulation perimeter and exclusion", pattern: /Report Date \(6,365,298\.65\)[\s\S]*?Not Issued[\s\S]*?\(4,564,394\.91\)/i },
    { label: "MYR assets versus MYRC nominal assertion", pattern: /Fair\s+Value of Assets[\s\S]*?meets or exceeds the quantity of\s+MYRC in Circulation/i },
    { label: "signed date", pattern: /29 September 2026/ },
    { label: "restricted use preserved", pattern: /We do not assume responsibility to any other person/i },
  ],
  rejectedText: [
    { label: "nonqualifying opinion or AUP", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for|agreed[ -]upon[ -]procedures|not an assurance engagement/i },
  ],
  reportedTotals: [
    { label: "asserted MYR asset total", expected: "1800903.74", pattern: /Total\s+Malaysian\s+Ringgit\s+\(MYR\)\s+([0-9][0-9,]*\.[0-9]{2})/i },
    { label: "MYRC circulation", expected: "1800903.74", pattern: /MYRC in Circulation\s*=\s*([0-9][0-9,]*\.[0-9]{2})\s*MYRC/ },
    { label: "itemized MYR asset total", expected: "1800903.77", pattern: /^\s*Total\s+([0-9][0-9,]*\.[0-9]{2})\s+100\.00%\s*$/im },
  ],
  reportedAssetTotal: "1800903.74",
  computedAssetTotal: "1800903.77",
  reportedLiabilityTotal: "1800903.74",
};
