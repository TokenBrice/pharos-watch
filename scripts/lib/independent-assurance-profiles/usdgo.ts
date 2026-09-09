import { linePattern, AMOUNT, type CompilerProfile } from "./shared";

function usdgoScheduleAmountPattern(schedule: string, label: string): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- schedule/label are fixed literals from the reviewed extraction tables below.
  return new RegExp(`${schedule}[\\s\\S]*?^\\s*${label}\\s+\\$?${AMOUNT}\\s*$`, "im");
}

export const PROFILE: CompilerProfile = {
  product: "USDGO",
  profile: "usdgo-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usdgo-reserve-attestations",
  reportUrl: "https://learn.anchorage.com/07.31.26_USDGO-Stablecoin-Attestation-Report-signed.pdf",
  reportDate: "2026-07-31",
  reportAsOf: "2026-07-31T23:59:59Z",
  reportTimeZone: "UTC",
  reportIssuedAt: "2026-08-28T23:59:00Z",
  attestor: "Deloitte & Touche LLP",
  engagement: "Independent accountant's examination under AICPA attestation standards",
  conclusion: "unmodified",
  unit: "USD",
  assetRows: [
    { code: "cash", label: "Cash", pattern: linePattern("Cash") },
    { code: "buidl", label: "BUIDL at fair value", pattern: linePattern("BUIDL, at fair value") },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "stbxx", label: "STBXX money market fund (CUSIP 38151N205)", pattern: /^\s*a\.\s+38151N205\s+N\/A\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { code: "jltxx", label: "JLTXX money market fund (CUSIP 46655R119)", pattern: /^\s*b\.\s+46655R119\s+N\/A\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)\s*$/im },
  ],
  liabilityRows: [
    {
      code: "solana",
      label: "Solana USDGO redeemable tokens",
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
      pattern: /^\s*a\.\s+Total USDGO natively minted tokens\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(?:[0-9][0-9,]*(?:\.[0-9]+)?|-)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im,
    },
  ],
  requiredText: [
    { label: "AICPA attestation standards", pattern: /American Institute of Certi(?:f|ﬁ)ied Public Accountants[\s\S]*AICPA/i },
    { label: "USDGO July 2026 report date", pattern: /July 31, 2026[\s\S]*11:59:59 PM Coordinated Universal Time/i },
    { label: "favorable examination conclusion", pattern: /fairly stated, in all material respects/i },
    { label: "USDGO Schedule I", pattern: /Schedule I: Total USDGO Natively Minted Tokens/i },
    { label: "USDGO Schedule II", pattern: /Schedule II: Composition of Reserve Assets/i },
    { label: "USDGO Schedule III", pattern: /Schedule III: Comparison Between the Reserve Assets/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    // The reviewed dash is zero; omit the empty chain from positive liability rows.
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over the reviewed offline report.
    { label: "USDGO Morph liabilities", expected: "0", pattern: /^\s*a\.\s+Total USDGO natively minted tokens\s+[0-9][0-9,]*(?:\.[0-9]+)?\s+([0-9][0-9,]*(?:\.[0-9]+)?|-)\s+[0-9][0-9,]*(?:\.[0-9]+)?\s*$/im, },
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored per-line pattern over an offline reviewed PDF text dump; bounded digit runs, no nested quantifier ambiguity.
    { label: "USDGO redeemable token total", expected: "1112640495", pattern: /^\s*Total USDGO redeemable tokens outstanding\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s+\(Schedule I\))?\s*$/im },
    { label: "USDGO reserve asset total", expected: "1116301304", pattern: usdgoScheduleAmountPattern("Schedule II:", "Total") },
  ],
  reportedAssetTotal: "1116301304",
  computedAssetTotal: "1116301304",
  reportedLiabilityTotal: "1112640495",
};
