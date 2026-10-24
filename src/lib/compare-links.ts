import { CLIENT_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";

export const STATIC_COMPARE_PAIRS = [
  ["usdt-tether", "usdc-circle"],
  ["usdt-tether", "usde-ethena"],
  ["usdt-tether", "dai-makerdao"],
  ["usdt-tether", "usds-sky"],
  ["usdc-circle", "usde-ethena"],
  ["usdc-circle", "dai-makerdao"],
  ["usdc-circle", "usds-sky"],
  ["usde-ethena", "dai-makerdao"],
  ["usde-ethena", "usds-sky"],
  ["usds-sky", "dai-makerdao"],
  ["rlusd-ripple", "usdc-circle"],
  ["usdt-tether", "pyusd-paypal"],
  ["usdt-tether", "rlusd-ripple"],
  ["usdc-circle", "pyusd-paypal"],
  ["usdt-tether", "fdusd-first-digital"],
  ["usdc-circle", "fdusd-first-digital"],
  ["usdt-tether", "frax-frax"],
  ["usdc-circle", "frax-frax"],
  ["dai-makerdao", "gho-aave"],
  ["dai-makerdao", "crvusd-curve"],
  ["gho-aave", "crvusd-curve"],
  ["usdt-tether", "usd0-usual"],
  ["usdc-circle", "usd0-usual"],
  ["usde-ethena", "susde-ethena"],
  ["lusd-liquity", "bold-liquity"],
  ["paxg-paxos", "xaut-tether"],
  ["eurc-circle", "eurs-stasis"],
  ["usdt-tether", "tusd-trueusd"],
  ["usdt-tether", "usdd-tron-dao-reserve"],
  ["usdc-circle", "usdg-paxos"],
  // 2026-07 expansion, batch 1 — demand-led (Search Console) plus cohort
  // completion. Eligibility gate: active coins only (no pre-launch, no
  // frozen), full static profiles on both sides.
  ["usdt-tether", "usdg-paxos"],
  ["usdg-paxos", "pyusd-paypal"],
  ["rlusd-ripple", "pyusd-paypal"],
  ["rlusd-ripple", "usde-ethena"],
  ["rlusd-ripple", "usdg-paxos"],
  ["usdt-tether", "usdtb-ethena"],
  ["usde-ethena", "usdtb-ethena"],
  ["usdt-tether", "ausd-agora"],
  ["usdc-circle", "musd-metamask"],
  ["usde-ethena", "usdf-falcon"],
  ["fxusd-f-x-protocol", "crvusd-curve"],
  ["gho-aave", "usds-sky"],
  ["usdy-ondo-finance", "buidl-blackrock"],
  ["sdai-sky", "susde-ethena"],
  ["eurc-circle", "eure-monerium"],
  ["eurc-circle", "eur0-usual"],
  ["brla-brla-digital", "brz-transfero"],
  // 2026-10 expansion — sibling demand (combined profile impressions in
  // Search Console) under the same gate: active, non-frozen, full profiles.
  ["jpyc-jpyc", "jpysc-sbi-startale"],
  ["usdy-ondo-finance", "usyc-hashnote"],
  ["eurc-circle", "eurcv-societe-generale-forge"],
  ["xaut-tether", "xaum-matrixdock"],
  ["usd1-world-liberty-financial", "usdt-tether"],
  ["brla-brla-digital", "brl1-brl1"],
  // Base vs staked or vault wrapper, following the USDe/sUSDe precedent.
  ["gho-aave", "sgho-aave"],
  ["usdf-falcon", "susdf-falcon"],
  ["apxusd-apyx", "apyusd-apyx"],
] as const;

export function buildLiveCompareUrl(coinIds: readonly string[]): string {
  return `/compare/?coins=${coinIds.map((coinId) => encodeURIComponent(coinId)).join(",")}`;
}

export function buildStaticComparisonSlug(leftId: string, rightId: string): string {
  return `${leftId}-vs-${rightId}`;
}

/**
 * Static HTML links the live picker as `/compare/#coins=<ids>`: crawlers see
 * one `/compare/` URL instead of a facet per coin (IX3), and the picker adopts
 * the fragment into its `?coins=` state on load, so the visitor still lands
 * prefilled. Use `buildLiveCompareUrl` only for client-side navigation.
 */
const COMPARE_PREFILL_HASH_PREFIX = "#coins=";

export function buildComparePrefillUrl(coinIds: readonly string[]): string {
  return `/compare/${COMPARE_PREFILL_HASH_PREFIX}${coinIds.map((coinId) => encodeURIComponent(coinId)).join(",")}`;
}

/** Coin IDs from a `#coins=` prefill fragment, or null for any other hash. */
export function parseComparePrefillHash(hash: string): string[] | null {
  if (!hash.startsWith(COMPARE_PREFILL_HASH_PREFIX)) return null;
  const ids = hash
    .slice(COMPARE_PREFILL_HASH_PREFIX.length)
    .split(",")
    .map((value) => {
      try {
        return decodeURIComponent(value).trim();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  return ids.length > 0 ? ids : null;
}

function findStaticComparePair(leftId: string, rightId: string) {
  return STATIC_COMPARE_PAIRS.find(
    ([pairLeft, pairRight]) =>
      (pairLeft === leftId && pairRight === rightId) || (pairLeft === rightId && pairRight === leftId),
  );
}

/**
 * The crawlable "Compare" target for static HTML: the curated pair page when
 * one exists (a coin's primary pair; for two coins, their pair), otherwise the
 * picker prefilled client-side. Never a `/compare/?coins=` facet URL.
 */
export function buildStaticCompareHref(coinIds: readonly string[]): string {
  if (coinIds.length === 1) {
    return getPrimaryStaticComparisonLinkForCoin(coinIds[0])?.href ?? buildComparePrefillUrl(coinIds);
  }
  const pair = coinIds.length === 2 ? findStaticComparePair(coinIds[0], coinIds[1]) : undefined;
  return pair ? `/compare/${buildStaticComparisonSlug(pair[0], pair[1])}/` : buildComparePrefillUrl(coinIds);
}

export interface StaticComparisonLink {
  href: string;
  benchmarkSymbol: string | null;
}

export function getPrimaryStaticComparisonLinkForCoin(coinId: string): StaticComparisonLink | null {
  // For USDe, explain the staking wrapper before the broader dollar benchmark.
  const pair = (coinId === "usde-ethena"
    ? STATIC_COMPARE_PAIRS.find(([leftId, rightId]) => leftId === coinId && rightId === "susde-ethena")
    : undefined) ?? STATIC_COMPARE_PAIRS.find(([leftId, rightId]) => leftId === coinId || rightId === coinId);
  if (!pair) return null;

  const [leftId, rightId] = pair;
  const benchmarkId = leftId === coinId ? rightId : leftId;
  return {
    href: `/compare/${buildStaticComparisonSlug(leftId, rightId)}/`,
    benchmarkSymbol: CLIENT_TRACKED_META_BY_ID.get(benchmarkId)?.symbol ?? null,
  };
}
