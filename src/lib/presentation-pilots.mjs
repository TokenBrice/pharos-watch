/** PT1's five-profile cohort. Other profiles keep their live-only History. */
/** @type {ReadonlySet<string>} */
export const STABLECOIN_DETAIL_HISTORY_PILOT_IDS = new Set([
  "usdt-tether",
  "usdc-circle",
  "tusd-trueusd",
  "dai-makerdao",
  "fdusd-first-digital",
]);

/** Bounded W2/C8 pairs with reviewed source-linked evidence rows. */
/** @type {ReadonlySet<string>} */
export const COMPARISON_EVIDENCE_PILOT_SLUGS = new Set([
  "usdc-circle-vs-usdg-paxos",
  "usdt-tether-vs-usdg-paxos",
  "rlusd-ripple-vs-usdc-circle",
  "paxg-paxos-vs-xaut-tether",
  "usdt-tether-vs-usdc-circle",
  "usde-ethena-vs-usds-sky",
]);

/** Three chain profiles with the bounded recorded-contract table. */
export const CHAIN_CONTRACT_TABLE_PILOTS = [
  { chain: "solana", chainName: "Solana" },
  { chain: "base", chainName: "Base" },
  { chain: "tron", chainName: "Tron" },
];
