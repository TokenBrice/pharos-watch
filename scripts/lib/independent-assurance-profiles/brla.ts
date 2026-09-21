import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "BRLA",
  profile: "brla-v1",
  officialIndexUrl: "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  reportUrl: "https://file.notion.so/f/f/7cc5d753-b4f1-4267-9ad1-3e6bd0141d8d/8494e9ac-19af-4dfb-b05c-ba1aba60b30c/Avenia_-_Transparency_Report_-_20260831_(Audit_Attestation).pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:59+00:00",
  reportTimeZone: "UTC (as printed in the assurance report; the enclosed Transparency Report prints 21:00:00 BRT)",
  reportIssuedAt: "2026-09-16T14:14:54-03:00",
  attestor: "UHY Bendoraytes & Cia Auditores Independentes",
  engagement: "Independent auditors' reasonable assurance engagement under NBC TO 3000 (ISAE 3000 equivalent)",
  conclusion: "unmodified",
  unit: "BRL",
  assetRows: [
    {
      code: "cash-and-cash-equivalents",
      label: "BRL cash and cash equivalents held at named Brazilian financial institutions",
      pattern: linePattern("Cash or Equivalent"),
    },
    {
      code: "repurchase-agreements",
      label: "Overnight repurchase agreements collateralized by Brazilian corporate debentures",
      pattern: linePattern("Repurchase agreements"),
    },
  ],
  liabilityRows: [
    { code: "polygon", label: "Polygon PoS Chain BRLA redeemable tokens", pattern: linePattern("Polygon PoS Chain") },
    { code: "moonbeam", label: "Moonbeam Chain BRLA redeemable tokens", pattern: linePattern("Moonbeam Chain") },
    { code: "celo", label: "Celo Chain BRLA redeemable tokens", pattern: linePattern("Celo Chain") },
    { code: "gnosis", label: "Gnosis Chain BRLA redeemable tokens", pattern: linePattern("Gnosis Chain") },
  ],
  requiredText: [
    { label: "UHY Bendoraytes", pattern: /UHY\s+BENDORAYTES|UHY\s+Bendoraytes/i },
    { label: "NBC TO 3000", pattern: /NBC TO 3000/i },
    { label: "ISAE 3000", pattern: /ISAE 3000/i },
    { label: "reasonable assurance report", pattern: /REASONABLE ASSURANCE REPORT/i },
    { label: "examined instant", pattern: /11:59:59 PM \+UTC/i },
    { label: "favorable BRLA conclusion", pattern: /adequately presented, in all material respects/i },
    { label: "signature date", pattern: /September 16, 2026/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "cash or equivalent total", expected: "55450919.48", pattern: linePattern("Cash or Equivalent") },
    { label: "repurchase agreements total", expected: "107999999.90", pattern: linePattern("Repurchase agreements") },
    { label: "reserve grand total", expected: "163450919.38", pattern: linePattern("Grand Total") },
    { label: "circulation grand total", expected: "132765684.39", pattern: /^\s*Grand Total\s+(132,765,684\.39)\s*$/im },
    { label: "polygon circulation", expected: "19752048.94", pattern: linePattern("Polygon PoS Chain") },
    { label: "celo circulation", expected: "110510325.92", pattern: linePattern("Celo Chain") },
  ],
  reportedAssetTotal: "163450919.38",
  computedAssetTotal: "163450919.38",
  reportedLiabilityTotal: "132765684.39",
};
