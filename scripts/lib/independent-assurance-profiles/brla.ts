import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "BRLA",
  profile: "brla-v1",
  officialIndexUrl: "https://brladigital.notion.site/BRLA-Transparency-Page-238ba143aa2f4338902ee91ebe50298a",
  reportUrl: "https://file.notion.com/f/f/7cc5d753-b4f1-4267-9ad1-3e6bd0141d8d/6674dccd-e58f-4da9-a3d1-c4ae0d676fea/Avenia_-_Transparency_Report_-_20260930_(Audit_Attestation).pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:59+00:00",
  reportTimeZone: "UTC (as printed in the assurance report; the enclosed Transparency Report prints 21:00:00 BRT)",
  reportIssuedAt: "2026-10-16T13:50:19-03:00",
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
    { label: "examined period", pattern: /September\s+30,\s+2026/i },
    { label: "report date", pattern: /October 15, 2026/i },
    { label: "digital signature date", pattern: /2026\.10\.16/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "cash or equivalent total", expected: "72064692.29", pattern: linePattern("Cash or Equivalent") },
    { label: "repurchase agreements total", expected: "60103684.97", pattern: linePattern("Repurchase agreements") },
    { label: "reserve grand total", expected: "132168377.26", pattern: linePattern("Grand Total") },
    { label: "circulation grand total", expected: "129478160.68", pattern: /^\s*Grand Total\s+(129,478,160\.68)\s*$/im },
    { label: "polygon circulation", expected: "18468833.82", pattern: linePattern("Polygon PoS Chain") },
    { label: "celo circulation", expected: "108418360.97", pattern: linePattern("Celo Chain") },
  ],
  reportedAssetTotal: "132168377.26",
  computedAssetTotal: "132168377.26",
  reportedLiabilityTotal: "129478160.68",
};
