import type { CaseStudyOutcome } from "./types";

export interface CaseStudyClientSummary {
  readonly slug: string;
  readonly title: string;
  readonly outcome: CaseStudyOutcome;
}

export const CASE_STUDY_CLIENT_BY_COIN_ID: Record<string, CaseStudyClientSummary> = {
  "usdc-circle": {
    slug: "usdc-svb-2023",
    title: "USDC and the Silicon Valley Bank weekend",
    outcome: "survived",
  },
  "dai-makerdao": {
    slug: "dai-black-thursday",
    title: "Dai: Black Thursday and the PSM dependency",
    outcome: "survived",
  },
  "usde-ethena": {
    slug: "usde-oracle-2025",
    title: "USDe and the October 2025 Binance oracle print",
    outcome: "survived",
  },
  "usd0-usual": {
    slug: "usd0pp-usual-2025",
    title: "USD0++ depeg: when Usual changed the redemption floor",
    outcome: "wounded",
  },
  "crvusd-curve": {
    slug: "crvusd-exploit-trilogy",
    title: "crvUSD's exploit trilogy: three shocks, no collapse",
    outcome: "survived",
  },
  "usr-resolv": {
    slug: "usr-resolv-2026",
    title: "Resolv USD: when one key minted eighty million",
    outcome: "died",
  },
  "pmusd-precious-metals": {
    slug: "pmusd-precious-metals",
    title: "pmUSD and the in-situ gold collateral chain",
    outcome: "wounded",
  },
  "apxusd-apyx": {
    slug: "apxusd-dat-collateral",
    title: "apxUSD and the Bitcoin-treasury collateral chain",
    outcome: "wounded",
  },
};
