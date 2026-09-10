import { linePattern, type CompilerProfile } from "./shared";

export const PROFILE: CompilerProfile = {
  product: "EUROP",
  profile: "europ-v1",
  officialIndexUrl: "https://schuman.io/reserve-audits/",
  reportUrl: "https://schuman.io/wp-content/uploads/2026/07/SALVUS_Attestation_relative_au_nombre_de_jetons_EUROP_30_06_2026.pdf",
  reportDate: "2026-06-30",
  reportAsOf: "2026-06-30T08:00:00Z",
  reportTimeZone: "UTC",
  reportIssuedAt: "2026-07-03T10:06:52+02:00",
  attestor: "KPMG S.A.",
  engagement: "Statutory-auditor attestation under French CNCC professional doctrine; neither an audit nor a review",
  conclusion: "nothing-came-to-attention",
  unit: "EUR",
  assetRows: [
    { code: "cash", label: "Cash held at regulated financial institutions", pattern: linePattern("Cash Held at Regulated Financial Institutions") },
    { code: "cash-equivalents", label: "Cash equivalents held at regulated financial institutions", pattern: linePattern("Cash Equivalents Held at Regulated Financial Institutions") },
  ],
  liabilityRows: [
    { code: "ethereum", label: "Ethereum EURØP in circulation", pattern: linePattern("Ethereum") },
    { code: "polygon", label: "Polygon EURØP in circulation", pattern: linePattern("Polygon") },
    { code: "avalanche", label: "Avalanche EURØP in circulation", pattern: linePattern("Avalanche") },
    { code: "plasma", label: "Plasma EURØP in circulation", pattern: linePattern("Plasma") },
  ],
  requiredText: [
    { label: "KPMG S.A.", pattern: /KPMG S\.A\./i },
    { label: "statutory auditor", pattern: /statutory auditor/i },
    { label: "neither an audit nor a review", pattern: /neither an audit nor a review/i },
    { label: "EUROP report date", pattern: /June 30, 2026/i },
    { label: "favorable EUROP conclusion", pattern: /no matters to report/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for/i },
  ],
  reportedTotals: [
    { label: "EUROP circulation total", expected: "6840292.27", pattern: linePattern("EURØP in Circulation") },
    { label: "EUROP headline reserve total", expected: "7200276.54", pattern: linePattern("EURØP Cash and cash equivalent Reserve") },
  ],
  reportedAssetTotal: "7200276.54",
  computedAssetTotal: "7200276.13",
  reportedLiabilityTotal: "6840292.27",
};
