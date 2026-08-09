import type { FaqItem } from "@/lib/faq";

export const COVERAGE_FAQ_ITEMS = [
  {
    question: "What features does Pharos track for each stablecoin?",
    answer:
      "Pharos tracks nine core features per stablecoin: depeg monitoring with real-time price deviation alerts, DEX liquidity scoring across Curve, Uniswap, and other venues, reserve transparency views, modeled redemption backstop routes, yield intelligence across native yield and selected lending venues, configured issuance-chain mint/burn flow monitoring, blacklist event tracking for freeze-capable assets, dependency map visibility for collateral relationships, and safety grade report cards across four weighted base dimensions plus a peg-stability multiplier.",
  },
  {
    question: "Why do some stablecoins have incomplete coverage?",
    answer:
      "Coverage gaps typically stem from three factors: data availability (some newer or smaller stablecoins lack sufficient on-chain history for certain metrics), technical constraints (not all chains support the same level of RPC access for mint/burn tracking), and design differences (some wrapper or protocol-native designs do not expose traditional reserve reporting, while many assets do not expose a direct issuer or protocol redemption path). Pharos marks these gaps clearly rather than showing misleading placeholders.",
  },
  {
    question: "How often is coverage data updated?",
    answer:
      "Prices and peg scores refresh every 15 minutes. Safety score caches publish every 15 minutes, while daily safety-grade history powers historical snapshots and safety-change alerts. DEX liquidity, DEWS stress signals, PSI, and mint/burn flows refresh every 30 minutes. Yield rankings refresh hourly, with slower supplemental source families updated every four hours. Blacklist events refresh every six hours, and live reserve plus redemption backstop snapshots refresh every four hours. The coverage matrix reflects the current availability state and updates as new data sources come online or existing ones expand.",
  },
] as const satisfies readonly FaqItem[];
