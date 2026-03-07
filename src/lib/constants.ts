export const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export const CATEGORY_LINKS = [
  { href: "/stablecoins/usd/", param: "type", value: "usd", label: "USD Stablecoins" },
  { href: "/stablecoins/governance/cefi/", param: "type", value: "centralized", label: "CeFi Stablecoins" },
  {
    href: "/stablecoins/governance/cefi-dependent/",
    param: "type",
    value: "centralized-dependent",
    label: "CeFi-Dependent",
  },
  { href: "/stablecoins/governance/defi/", param: "type", value: "decentralized", label: "DeFi Stablecoins" },
  { href: "/stablecoins/backing/rwa/", param: "backing", value: "rwa-backed", label: "RWA-Backed" },
  { href: "/stablecoins/backing/crypto/", param: "backing", value: "crypto-backed", label: "Crypto-Backed" },
  { href: "/stablecoins/eur/", param: "peg", value: "eur-peg", label: "EUR Stablecoins" },
  { href: "/stablecoins/gold/", param: "peg", value: "gold-peg", label: "Gold-Backed" },
];
