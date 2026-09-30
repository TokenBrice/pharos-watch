import { linePattern, scheduleAmountPattern, type CompilerProfile } from "./shared";


export const PROFILE: CompilerProfile = {
  product: "USDGO",
  profile: "usdgo-v1",
  officialIndexUrl: "https://www.anchorage.com/platform/usdgo-reserve-attestations",
  reportUrl: "https://learn.anchorage.com/08.31.26_USDGO_Stablecoin_Attestation_Report%20(FINAL)%20signed_9.28.26.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:59Z",
  reportTimeZone: "UTC",
  reportIssuedAt: "2026-09-28T23:59:00Z",
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
    { label: "USDGO August 2026 report date", pattern: /August 31, 2026[\s\S]*11:59:59 PM Coordinated Universal Time/i },
    { label: "favorable examination conclusion", pattern: /fairly stated, in all[\s\S]{0,120}?material respects/i },
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
    { label: "USDGO redeemable token total", expected: "1244426424", pattern: /^\s*Total USDGO redeemable tokens outstanding\s+\$?([0-9][0-9,]*(?:\.[0-9]+)?)(?:\s+\(Schedule I\))?\s*$/im },
    { label: "USDGO reserve asset total", expected: "1248950562", pattern: scheduleAmountPattern("Schedule II:", "Total") },
  ],
  reportedAssetTotal: "1248950562",
  computedAssetTotal: "1248950562",
  reportedLiabilityTotal: "1244426424",
};
