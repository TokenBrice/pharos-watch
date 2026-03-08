import type { PegCurrency } from "@shared/types";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { PEG_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";

// ---------------------------------------------------------------------------
// Slug ↔ PegCurrency mapping
// ---------------------------------------------------------------------------

const ALL_SLUGS: Record<PegCurrency, string> = {
  USD: "usd",
  EUR: "eur",
  GBP: "gbp",
  CHF: "chf",
  BRL: "brl",
  JPY: "jpy",
  SGD: "sgd",
  TRY: "try",
  AUD: "aud",
  ZAR: "zar",
  CAD: "cad",
  PHP: "php",
  RUB: "rub",
  CNY: "cny",
  CNH: "cnh",
  MXN: "mxn",
  UAH: "uah",
  ARS: "ars",
  IDR: "idr",
  GOLD: "gold",
  SILVER: "silver",
  VAR: "cpi",
  OTHER: "other",
};

/** Only pegs with at least one tracked stablecoin. */
export const ACTIVE_PEGS: PegCurrency[] = (() => {
  const seen = new Set<PegCurrency>();
  for (const coin of TRACKED_STABLECOINS) {
    seen.add(coin.flags.pegCurrency);
  }
  // Return in a stable order (same as ALL_SLUGS key order)
  return (Object.keys(ALL_SLUGS) as PegCurrency[]).filter((p) => seen.has(p));
})();

/** PegCurrency → URL slug (only active pegs). */
export const PEG_SLUGS: Partial<Record<PegCurrency, string>> = Object.fromEntries(
  ACTIVE_PEGS.map((peg) => [peg, ALL_SLUGS[peg]]),
);

/** URL slug → PegCurrency (only active pegs). */
export const SLUG_TO_PEG: Record<string, PegCurrency> = Object.fromEntries(
  ACTIVE_PEGS.map((peg) => [ALL_SLUGS[peg], peg]),
);

/** Number of tracked stablecoins per peg currency. */
export function pegCoinCount(peg: PegCurrency): number {
  return TRACKED_STABLECOINS.filter((c) => c.flags.pegCurrency === peg).length;
}

// ---------------------------------------------------------------------------
// SEO intro paragraphs
// ---------------------------------------------------------------------------

export const PEG_INTRO: Partial<Record<PegCurrency, string>> = {
  USD: `USD stablecoins are the backbone of DeFi liquidity, collectively representing the vast majority of all stablecoin market cap. They range from fully centralized, fiat-reserve-backed tokens like USDC and USDT to decentralized, crypto-collateralized designs like DAI and LUSD. Governance models, reserve transparency, and blacklist policies vary widely across issuers. Pharos tracks peg stability, circulating supply, safety grades, and DEX liquidity for every USD-pegged stablecoin so you can compare them on a level playing field.`,

  EUR: `Euro-pegged stablecoins serve the eurozone DeFi ecosystem, enabling on-chain EUR exposure without fiat off-ramps. Issuers range from regulated EU financial institutions (like Société Générale's EURCV) to decentralized protocols. With MiCA regulation reshaping the European stablecoin landscape, euro pegs are evolving rapidly. Pharos monitors peg deviation, market cap changes, and risk grades for every EUR stablecoin.`,

  GBP: `British Pound stablecoins provide on-chain GBP exposure for UK-focused DeFi users and cross-border payments. Though the GBP stablecoin market is smaller than USD or EUR, it serves an important niche. Pharos tracks peg accuracy and supply for each GBP-pegged token.`,

  CHF: `Swiss Franc stablecoins offer exposure to one of the world's most stable fiat currencies. Pegged to the CHF, these tokens appeal to users seeking a non-USD, low-volatility store of value on-chain. Pharos monitors their peg performance and market data.`,

  BRL: `The Brazilian Real peg serves the growing Latin American DeFi market. Pharos tracks peg deviation and supply for BRL-pegged stablecoins, providing visibility into this emerging market segment.`,

  JPY: `Japanese Yen stablecoins provide on-chain JPY exposure for Asian DeFi markets. With Japan's progressive crypto regulation, JPY pegs are an important bridge between traditional finance and decentralized protocols. Pharos tracks their peg stability and market metrics.`,

  SGD: `The Singapore Dollar stablecoin peg serves Southeast Asian DeFi users. Pharos tracks peg accuracy and supply for SGD-pegged tokens in this emerging market.`,

  TRY: `Turkish Lira stablecoins offer on-chain TRY exposure in a high-inflation environment where stable digital alternatives are particularly valuable. Pharos monitors peg deviation and market data for TRY-pegged tokens.`,

  AUD: `Australian Dollar stablecoins provide on-chain AUD exposure for the Oceanian DeFi market. Pharos tracks peg performance and supply for AUD-pegged tokens.`,

  ZAR: `The South African Rand stablecoin peg serves the African DeFi ecosystem. Pharos tracks peg deviation and supply for ZAR-pegged stablecoins, bringing transparency to this emerging market.`,

  CAD: `Canadian Dollar stablecoins provide on-chain CAD exposure for North American DeFi users. Pharos monitors peg accuracy and market metrics for CAD-pegged tokens.`,

  CNH: `Offshore Yuan stablecoins provide on-chain CNH exposure for cross-border settlement and Asian DeFi markets. Because CNH trades separately from onshore CNY, Pharos evaluates CNH-pegged tokens against a dedicated offshore yuan FX reference rather than folding them into the CNY bucket.`,

  PHP: `Philippine Peso stablecoins serve the Southeast Asian remittance and DeFi market. Pharos tracks peg deviation and supply for PHP-pegged tokens.`,

  RUB: `The Russian Ruble stablecoin peg provides on-chain RUB exposure. Pharos tracks peg performance and supply data for RUB-pegged tokens.`,

  GOLD: `Gold-pegged stablecoins tokenize physical gold, with each token typically backed by one troy ounce of London Good Delivery gold held in insured vaults. PAXG and XAUT are the largest, both regulated and fully reserved. Unlike fiat pegs, gold stablecoin prices track the spot gold market, making them a hedge against both crypto volatility and fiat inflation. Pharos monitors their peg accuracy against live gold prices, supply changes, and safety grades.`,

  SILVER: `Silver-pegged stablecoins tokenize physical silver, tracking the spot silver market on-chain. Pharos monitors peg accuracy and supply for silver-backed tokens.`,

  VAR: `CPI-pegged stablecoins (variable pegs) are designed to preserve purchasing power by tracking inflation indices rather than a fixed fiat price. Their target price appreciates over time as inflation accrues. Pharos monitors their peg performance relative to their variable target.`,
};

// Re-export for convenience
export { PEG_LABELS, PEG_LABELS_SHORT };
