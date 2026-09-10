import { linePattern, type CompilerProfile } from "./shared";

export function straitsxProfile(
  product: "XSGD" | "XUSD",
  unit: "SGD" | "USD",
  assetTotal: string,
  liabilityTotal: string,
): CompilerProfile {
  const xsgd = product === "XSGD";
  return {
    product,
    profile: "straitsx-v1",
    officialIndexUrl: `https://www.straitsx.com/${product.toLowerCase()}`,
    reportUrl: xsgd
      ? "https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/6a9e13a54059e618ca8c06e3_XSGD%20SCS%20Reserve%20Account%20Report%20(31%20July%202026).pdf"
      : "https://cdn.prod.website-files.com/6119d1f2b05f8e65b1739721/6a9e145187f4227fbe226ec2_XUSD%20SCS%20Reserve%20Account%20Report%20(31%20July%202026).pdf",
    reportDate: "2026-07-31",
    reportAsOf: "2026-07-31T23:59:00+08:00",
    reportTimeZone: "Singapore Time (GMT+8)",
    attestor: "KK Yap & Associates",
    engagement: "Independent accountant's reasonable-assurance examination under SSAE 3000 (Revised)",
    conclusion: "unqualified",
    unit,
    assetRows: xsgd
      ? [
          { code: "cash", label: "Cash", pattern: linePattern("Cash") },
          { code: "short-dated-government-or-repo", label: "Bonds or notes denominated in SGD with no more than three months residual maturity or eligible overnight reverse repos", pattern: /^\s*Bonds or notes denominated in SGD[^\n]*?\s+([0-9][0-9,]*)\s*$/im },
        ]
      : [
          { code: "cash", label: "Cash", pattern: linePattern("Cash") },
          { code: "fixed-deposits", label: "Fixed Deposits", pattern: linePattern("Fixed Deposits") },
          { code: "short-dated-government-or-repo", label: "U.S. Treasury or eligible overnight reverse-repo instruments", pattern: /^\s*Bonds or notes denominated in USD[^\n]*?\s+([0-9][0-9,]*)\s*$/im },
        ],
    liabilityRows: xsgd
      ? [
          { code: "erc20", label: "XSGD ERC20 circulation", pattern: linePattern("XSGD \\(ERC20\\)") },
          { code: "zrc2", label: "XSGD ZRC2 circulation", pattern: linePattern("XSGD \\(ZRC2\\)") },
          { code: "pos", label: "XSGD POS circulation", pattern: linePattern("XSGD \\(POS\\)") },
          { code: "hts", label: "XSGD HTS circulation", pattern: linePattern("XSGD \\(HTS\\)") },
          { code: "avax", label: "XSGD AVAX circulation", pattern: linePattern("XSGD \\(AVAX\\)") },
          { code: "arb", label: "XSGD ARB circulation", pattern: linePattern("XSGD \\(ARB\\)") },
          { code: "xrp", label: "XSGD XRP circulation", pattern: linePattern("XSGD \\(XRP\\)") },
          { code: "lat", label: "XSGD LAT circulation", pattern: linePattern("XSGD \\(LAT\\)") },
          { code: "base", label: "XSGD BASE circulation", pattern: linePattern("XSGD \\(BASE\\)") },
          { code: "sol", label: "XSGD SOL circulation", pattern: linePattern("XSGD \\(SOL\\)") },
          { code: "xlayer", label: "XSGD XLAYER circulation", pattern: linePattern("XSGD \\(XLAYER\\)") },
        ]
      : [
          { code: "erc20", label: "XUSD ERC20 circulation", pattern: linePattern("XUSD \\(ERC20\\)") },
          { code: "bep20", label: "XUSD BEP20 circulation", pattern: linePattern("XUSD \\(BEP20\\)") },
          { code: "pol", label: "XUSD POL circulation", pattern: linePattern("XUSD \\(POL\\)") },
          { code: "sol", label: "XUSD SOL circulation", pattern: linePattern("XUSD \\(SOL\\)") },
        ],
    requiredText: [
      { label: "KK Yap & Associates", pattern: /KK YAP & ASSOCIATES/i },
      { label: "SSAE 3000", pattern: /SSAE\)?\s*3000/i },
      { label: "reasonable assurance", pattern: /reasonable assurance/i },
      { label: `${product} report date`, pattern: /31 July 2026/i },
      { label: "favorable StraitsX conclusion", pattern: /in our opinion[\s\S]*fairly stated/i },
    ],
    rejectedText: [
      { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
    ],
    reportedTotals: [
      { label: `${product} circulation total`, expected: liabilityTotal.replace(/,/g, ""), pattern: linePattern(`A\\. Total par value1 of ${product} in circulation`) },
      { label: `${product} reserve total`, expected: assetTotal.replace(/,/g, ""), pattern: linePattern("B\\. Marked-to-market value of Reserve Assets held in a trust account") },
    ],
    reportedAssetTotal: assetTotal.replace(/,/g, ""),
    computedAssetTotal: assetTotal.replace(/,/g, ""),
    reportedLiabilityTotal: liabilityTotal.replace(/,/g, ""),
  };
}
