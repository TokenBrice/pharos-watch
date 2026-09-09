import { type CompilerProfile } from "./shared";

// Brazilian decimal format: dot thousands separators, comma decimal separator
// (e.g. "R$ 231.887.240,50" = 231887240.50).
const BRL_AMOUNT = "([\\d.]+,\\d{2})";
const normalizeBRL = (raw: string): string => raw.replace(/\./g, "").replace(/,/g, ".");

export const PROFILE: CompilerProfile = {
  product: "BRLV",
  profile: "brlv-v1",
  officialIndexUrl: "https://www.crown-brlv.com/en/transparency/",
  reportUrl: "https://dfg4lo8c2lfcn.cloudfront.net/report_brlv_8_2026_1ea3d5e0be.pdf",
  reportDate: "2026-08-31",
  reportAsOf: "2026-08-31T23:59:59-03:00",
  reportTimeZone: "Brasília Time (BRT, UTC-3)",
  attestor: "Fact Finance Ltda",
  engagement:
    "Independent technical Proof of Reserves verification memo (an RWA verification agent, not an accounting/audit firm; the signer is a technical lead, not a licensed accountant)",
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
      pattern: new RegExp(`Brazilian Treasury Bonds\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+60\\.97%`),
    },
    {
      code: "treasury-bonds-secondary",
      label: "Brazilian Treasury Bonds",
      pattern: new RegExp(`Brazilian Treasury Bonds\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+39\\.01%`),
    },
    {
      code: "etf-treasury-primary",
      label: "ETFs – Brazilian Treasury",
      pattern: new RegExp(`ETFs – Brazilian Treasury\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+0\\.01%`),
    },
    {
      code: "etf-treasury-secondary",
      label: "ETFs – Brazilian Treasury",
      pattern: new RegExp(`ETFs – Brazilian Treasury\\s+-?\\s+R\\$\\s*${BRL_AMOUNT}\\s+0\\.00%`),
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
    { label: "collateralization 100.60%", pattern: /100\.60%/ },
    { label: "BRLV report date", pattern: /31\/08\/2026/ },
    { label: "technical-lead signer", pattern: /Responsável técnico/ },
    { label: "favorable BRLV conclusion", pattern: /reservas colaterais superiores ao\s+total de tokens emitidos/i },
  ],
  rejectedText: [
    { label: "qualified/adverse/disclaimed conclusion", pattern: /qualified opinion|adverse opinion|disclaimer of opinion|except for|ressalva|opinião adversa|abstenção de opinião/i },
  ],
  reportedTotals: [
    { label: "BRLV circulation total", expected: "378063743.00", pattern: new RegExp(`Tokens em circulação\\s+R\\$\\s*${BRL_AMOUNT}`) },
    { label: "BRLV reserve total", expected: "380315618.44", pattern: new RegExp(`Reservas colaterais totais\\s+R\\$\\s*${BRL_AMOUNT}`) },
  ],
  reportedAssetTotal: "380315618.44",
  computedAssetTotal: "380315618.44",
  reportedLiabilityTotal: "378063743.00",
};
