import type { PegCurrency } from "@shared/types";
import { PEG_LABELS, PEG_LABELS_SHORT } from "@shared/lib/classification";
import { ACTIVE_PEG_CURRENCIES, ACTIVE_PEG_CURRENCY_COUNTS } from "@/lib/stablecoin-static-data";

const ACTIVE_PEG_COUNTS: Partial<Record<PegCurrency, number>> = ACTIVE_PEG_CURRENCY_COUNTS;

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
  KRW: "krw",
  SGD: "sgd",
  MYR: "myr",
  TRY: "try",
  AUD: "aud",
  ZAR: "zar",
  CAD: "cad",
  PHP: "php",
  RUB: "rub",
  CNY: "cny",
  CNH: "cnh",
  MXN: "mxn",
  VND: "vnd",
  UAH: "uah",
  ARS: "ars",
  KGS: "kgs",
  NGN: "ngn",
  XOF: "xof",
  COP: "cop",
  CLP: "clp",
  GHS: "ghs",
  KES: "kes",
  PEN: "pen",
  IDR: "idr",
  INR: "inr",
  HKD: "hkd",
  GOLD: "gold",
  SILVER: "silver",
  VAR: "cpi",
  OTHER: "other",
};

/** Only pegs with at least one tracked stablecoin. */
export const ACTIVE_PEGS: PegCurrency[] = [...ACTIVE_PEG_CURRENCIES];

/** PegCurrency → URL slug (only active pegs). */
export const PEG_SLUGS: Partial<Record<PegCurrency, string>> = Object.fromEntries(
  ACTIVE_PEGS.map((peg) => [peg, ALL_SLUGS[peg]]),
);

/** Number of tracked stablecoins per peg currency. */
export function pegCoinCount(peg: PegCurrency): number {
  return ACTIVE_PEG_COUNTS[peg] ?? 0;
}

/** Peg landing-page URL, or null when the peg has no landing page yet. */
export function buildPegLandingUrl(peg: PegCurrency): string | null {
  const slug = PEG_SLUGS[peg];
  return slug ? `/stablecoins/${slug}/` : null;
}

// ---------------------------------------------------------------------------
// SEO intro paragraphs
// ---------------------------------------------------------------------------

export const PEG_INTRO: Partial<Record<PegCurrency, string>> = {
  USD: `USD stablecoins are the backbone of DeFi liquidity, collectively representing the vast majority of all stablecoin market cap. They range from fully centralized, fiat-reserve-backed tokens like USDC and USDT to decentralized, crypto-collateralized designs like DAI and LUSD. Governance models, reserve transparency, and blacklist policies vary widely across issuers. Pharos tracks peg stability, circulating supply, safety grades, and DEX liquidity for every tracked USD-pegged stablecoin so you can compare them on a level playing field.`,

  EUR: `Euro-pegged stablecoins serve the eurozone DeFi ecosystem, enabling on-chain EUR exposure without fiat off-ramps. Issuers range from regulated EU financial institutions (like Société Générale's EURCV) to decentralized protocols. With MiCA regulation reshaping the European stablecoin landscape, euro pegs are evolving rapidly. Pharos monitors peg deviation, market cap changes, and risk grades for tracked EUR stablecoins.`,

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

  KGS: `Kyrgyz Som stablecoins provide on-chain KGS exposure for Central Asian payment, treasury, and remittance use cases. Pharos tracks peg performance and supply data for KGS-pegged tokens.`,

  NGN: `Nigerian Naira stablecoins provide on-chain NGN exposure for African payments, settlement, and remittance flows. Pharos tracks peg performance and supply data for NGN-pegged tokens.`,

  XOF: `West African CFA franc stablecoins provide on-chain XOF exposure for West African payments, settlement, and remittance flows. Pharos tracks peg performance and supply data for XOF-pegged tokens.`,

  GOLD: `Gold-pegged stablecoins tokenize physical gold, with each token typically backed by one troy ounce of London Good Delivery gold held in insured vaults. PAXG and XAUT are the largest, both regulated and fully reserved. Unlike fiat pegs, gold stablecoin prices track the spot gold market, making them a hedge against both crypto volatility and fiat inflation. Pharos monitors their peg accuracy against live gold prices, supply changes, and safety grades.`,

  SILVER: `Silver-pegged stablecoins tokenize physical silver, tracking the spot silver market on-chain. Pharos monitors peg accuracy and supply for silver-backed tokens.`,

  VAR: `CPI-pegged stablecoins (variable pegs) are designed to preserve purchasing power by tracking inflation indices rather than a fixed fiat price. Their target price appreciates over time as inflation accrues. Pharos monitors their peg performance relative to their variable target.`,
};

export const PEG_MARKET_CONTEXT: Partial<Record<PegCurrency, string>> = {
  USD: "USD pegs are the deepest settlement layer in DeFi, so the useful question is less whether the unit is liquid and more which issuer, collateral stack, blacklist surface, and redemption path you are accepting.",
  EUR: "EUR pegs sit at the intersection of eurozone payment demand, EU issuer regulation, and still-thin on-chain venue depth, so MiCA status and redemption access matter as much as headline supply.",
  GBP: "GBP pegs are a niche market for UK treasury, payments, and FX exposure, where issuer durability and venue coverage often matter more than raw token count.",
  CHF: "CHF pegs target users who want non-USD store-of-value exposure, but the cohort remains narrow enough that reserve transparency and exit liquidity should be checked coin by coin.",
  BRL: "BRL pegs are tied to Latin American payment and exchange use cases, where banking partner quality, local redemption rails, and issuer concentration can dominate day-to-day peg risk.",
  JPY: "JPY pegs bridge Japanese currency exposure into DeFi, but the cohort should be read against local licensing, low-yield fiat benchmarks, and limited secondary liquidity.",
  KRW: "KRW pegs are early on-chain won exposure; treat them as local-market payment infrastructure first and verify venue coverage before assuming global liquidity.",
  SGD: "SGD pegs lean on Singapore's role as a regional settlement hub, making regulatory posture and institutional redemption paths central to the risk read.",
  MYR: "MYR pegs are thinly represented on-chain, so the page is mainly a discovery surface for issuer provenance, chain coverage, and live market availability.",
  TRY: "TRY pegs serve a high-inflation local currency context, where the appeal of on-chain access should be balanced against issuer, banking, and liquidity risk.",
  AUD: "AUD pegs are built for Oceanian payment, treasury, and FX use cases, with most risk review starting from issuer backing quality and redemption availability.",
  ZAR: "ZAR pegs serve African market access and payment rails, but the cohort remains small enough that each asset's liquidity and reserve evidence need direct inspection.",
  CAD: "CAD pegs provide North American non-USD exposure; the practical risk lens is issuer regulation, reserve composition, and whether on-chain exits are deep enough.",
  PHP: "PHP pegs are often tied to remittance and payment use cases, where local fiat rails and operational coverage can be more important than broad DeFi composability.",
  RUB: "RUB pegs need extra attention to jurisdiction, sanctions exposure, issuer continuity, and where reliable secondary liquidity actually exists.",
  CNH: "CNH pegs reference offshore yuan rather than onshore CNY, so Pharos treats them as cross-border settlement assets with distinct FX and policy context.",
  MXN: "MXN pegs connect remittance, payment, and local treasury use cases; compare issuer rails and liquidity before treating them as generic dollar alternatives.",
  VND: "VND pegs are thinly represented and should be read as early local-currency infrastructure where source provenance and exchange access are the first checks.",
  ARS: "ARS pegs serve a high-inflation currency context, making live peg behavior, issuer controls, and redemption options especially important.",
  KGS: "KGS pegs are early Central Asian payment rails; use the page to verify whether tracked supply, chain coverage, and market data are deep enough for the intended use.",
  NGN: "NGN pegs connect African settlement and remittance demand to on-chain rails, where local banking access and liquidity depth are core risk inputs.",
  XOF: "XOF pegs map West African CFA franc exposure on-chain, so local redemption design and issuer operating jurisdiction are central to the review.",
  IDR: "IDR pegs provide Indonesian rupiah exposure; assess issuer licensing, local rails, and venue depth before relying on them for treasury flows.",
  GOLD: "Gold pegs are commodity exposure, not fiat cash equivalents; review custody, bar allocation, redemption terms, and tracking against spot gold rather than a fixed 1.00 target.",
  SILVER: "Silver pegs inherit commodity-market volatility and custody questions, so peg accuracy means tracking spot silver rather than holding a fiat unit.",
  VAR: "CPI and index pegs intentionally move with a reference index, so the key question is whether the target definition, oracle path, and redemption mechanism remain credible.",
  OTHER: "Other peg designs fall outside the main fiat and commodity buckets; start with the target definition, oracle source, collateral model, and whether Pharos has enough live evidence.",
};

// Re-export for convenience
export { PEG_LABELS, PEG_LABELS_SHORT };
