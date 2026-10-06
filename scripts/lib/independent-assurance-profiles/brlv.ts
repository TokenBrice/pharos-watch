import { type CompilerProfile } from "./shared";

// Brazilian decimal format: dot thousands separators, comma decimal separator
// (e.g. "R$ 231.887.240,50" = 231887240.50).
const BRL_AMOUNT = "([\\d.]+,\\d{2})";
const normalizeBRL = (raw: string): string => raw.replace(/\./g, "").replace(/,/g, ".");

export const PROFILE: CompilerProfile = {
  product: "BRLV",
  profile: "brlv-v1",
  officialIndexUrl: "https://www.crown-brlv.com/en/transparency/",
  reportUrl: "https://dfg4lo8c2lfcn.cloudfront.net/report_brlv_9_2026_b6d73237cb.pdf",
  reportDate: "2026-09-30",
  reportAsOf: "2026-09-30T23:59:59-03:00",
  reportTimeZone: "Brasília Time (BRT, UTC-3)",
  attestor: "Fact Finance Ltda",
  engagement:
    "Technical Proof of Reserves verification memo by Fact Finance Ltda, signed by Rodrigo Molin da Silva (CRC PR-052428/O; CNAI 10106); no stated audit or assurance engagement standard",
  conclusion: "issuer-attested",
  unit: "BRL",
  normalizeAmount: normalizeBRL,
  assetRows: [
    {
      code: "cash-equivalents",
      label: "Cash and equivalents",
      pattern: new RegExp(`Cash and equivalents\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}`),
    },
    {
      code: "treasury-bonds-primary",
      label: "Brazilian Treasury Bonds",
      pattern: new RegExp(`Brazilian Treasury Bonds\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+55\\.82%`),
    },
    {
      code: "treasury-bonds-secondary",
      label: "Brazilian Treasury Bonds",
      pattern: new RegExp(`Brazilian Treasury Bonds\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+39\\.71%`),
    },
    {
      code: "etf-treasury-primary",
      label: "ETFs – Brazilian Treasury",
      pattern: new RegExp(`ETFs – Brazilian Treasury\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+0\\.00%`),
    },
    {
      code: "etf-treasury-secondary",
      label: "ETFs – Brazilian Treasury",
      pattern: new RegExp(`ETFs – Brazilian Treasury\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+4\\.46%`),
    },
  ],
  liabilityRows: [
    {
      code: "circulation",
      label: "BRLV tokens in circulation (all networks)",
      pattern: new RegExp(`Tokens em circulação\\s+R\\$\\s*${BRL_AMOUNT}`),
    },
  ],
  requiredText: [
    { label: "Fact Finance", pattern: /Fact Finance/ },
    { label: "Prova de Reservas", pattern: /Prova de Reservas/ },
    { label: "collateralization 100.00%", pattern: /100\.00%/ },
    { label: "BRLV report date", pattern: /30\/09\/2026/ },
    { label: "registered accountant signer", pattern: /CRC PR-052428\/O - CNAI 10106/ },
    { label: "favorable BRLV conclusion", pattern: /reservas colaterais superiores ao\s+total de tokens emitidos/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for|ressalva|opinião adversa|abstenção de opinião/i },
  ],
  reportedTotals: [
    { label: "BRLV circulation total", expected: "377989540.00", pattern: new RegExp(`Tokens em circulação\\s+R\\$\\s*${BRL_AMOUNT}`) },
    { label: "BRLV reserve total", expected: "377991098.61", pattern: new RegExp(`Reservas colaterais totais\\s+R\\$\\s*${BRL_AMOUNT}`) },
  ],
  reportedAssetTotal: "377991098.61",
  computedAssetTotal: "377991098.61",
  reportedLiabilityTotal: "377989540.00",
};
