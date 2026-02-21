export const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export const CATEGORY_LINKS = [
  { href: "/?type=centralized", param: "type", value: "centralized", label: "CeFi Stablecoins" },
  { href: "/?type=centralized-dependent", param: "type", value: "centralized-dependent", label: "CeFi-Dependent" },
  { href: "/?type=decentralized", param: "type", value: "decentralized", label: "DeFi Stablecoins" },
  { href: "/?backing=rwa-backed", param: "backing", value: "rwa-backed", label: "RWA-Backed" },
  { href: "/?backing=crypto-backed", param: "backing", value: "crypto-backed", label: "Crypto-Backed" },
  { href: "/?peg=eur-peg", param: "peg", value: "eur-peg", label: "EUR Stablecoins" },
  { href: "/?peg=gold-peg", param: "peg", value: "gold-peg", label: "Gold-Backed" },
];
