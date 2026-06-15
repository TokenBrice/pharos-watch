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
  "lusd-liquity": {
    slug: "lusd-flight-to-safety-2023",
    title: "LUSD: the peg that held during the SVB weekend",
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
  "mai-qidao": {
    slug: "mai-qidao-bridge-2023",
    title: "MAI: the bridge that broke the peg",
    outcome: "wounded",
  },
  "susd-synthetix": {
    slug: "susd-sip420-2025",
    title: "sUSD and SIP-420: the depeg a governance vote chose",
    outcome: "wounded",
  },
  "fdusd-first-digital": {
    slug: "fdusd-sun-fdt-2025",
    title: "FDUSD and the insolvency tweet",
    outcome: "wounded",
  },
  "usdf-falcon": {
    slug: "usdf-falcon-2025",
    title: "USDf and the opacity discount",
    outcome: "wounded",
  },
  "usdx-kava": {
    slug: "usdx-kava-2022",
    title: "Kava USDX: one toxic collateral leg",
    outcome: "died",
  },
  "usdd-tron-dao-reserve": {
    slug: "usdd-tron-reserve-2024",
    title: "USDD: when the issuer pulled the Bitcoin",
    outcome: "wounded",
  },
};

/**
 * Client-safe cemetery-id → study lookup. Mirrors `CASE_STUDY_CLIENT_BY_COIN_ID`
 * so the cemetery UI (a client component) can link to a study without importing
 * the full registry — which would pull every study's article prose into the
 * client bundle. Kept in sync with the registry by the content test.
 */
export const CASE_STUDY_CLIENT_BY_CEMETERY_ID: Record<string, CaseStudyClientSummary> = {
  "iron-iron-2021-06": {
    slug: "iron-titan-2021",
    title: "IRON Finance & TITAN: the algorithmic prequel to Terra",
    outcome: "died",
  },
  "ust-terrausd-2022-05": {
    slug: "terra-ust-2022",
    title: "TerraUSD: the death spiral that erased $18 billion",
    outcome: "died",
  },
  "fei-fei-usd-2022-08": {
    slug: "fei-protocol",
    title: "Fei Protocol: the peg that broke at birth",
    outcome: "died",
  },
  "busd-binance-usd-2023-02": {
    slug: "busd-paxos-2023",
    title: "BUSD: the regulator's off-switch",
    outcome: "died",
  },
  "usdc-m-multichain-usdc-2023-07": {
    slug: "multichain-usdc-2023",
    title: "Multichain USDC: the bridge died, not the dollar",
    outcome: "died",
  },
  "eurt-euro-tether-2024-11": {
    slug: "eurt-mica-exit-2024",
    title: "Euro Tether: the stablecoin that died by jurisdiction",
    outcome: "died",
  },
  "xusd-stream-finance-xusd-2025-11": {
    slug: "stream-elixir-contagion-2025",
    title: "Stream Finance: when one fund manager's loss broke three stablecoins",
    outcome: "died",
  },
  "usr-resolv": {
    slug: "usr-resolv-2026",
    title: "Resolv USD: when one key minted eighty million",
    outcome: "died",
  },
  "usdn-neutrino-usd-2022-04": {
    slug: "usdn-neutrino-2022",
    title: "Neutrino USD: the billion-dollar algo death five weeks before Terra",
    outcome: "died",
  },
  "husd-husd-2022-10": {
    slug: "ftx-contagion-2022",
    title: "The FTX weekend: which pegs broke",
    outcome: "died",
  },
};
