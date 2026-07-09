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
] as const;

export function buildLiveCompareUrl(coinIds: readonly string[]): string {
  return `/compare/?coins=${coinIds.map((coinId) => encodeURIComponent(coinId)).join(",")}`;
}

export function buildStaticComparisonSlug(leftId: string, rightId: string): string {
  return `${leftId}-vs-${rightId}`;
}

export interface StaticComparisonLink {
  href: string;
  benchmarkSymbol: string | null;
}

export function getPrimaryStaticComparisonLinkForCoin(coinId: string): StaticComparisonLink | null {
  const pair = STATIC_COMPARE_PAIRS.find(([leftId, rightId]) => leftId === coinId || rightId === coinId);
  if (!pair) return null;

  const [leftId, rightId] = pair;
  const benchmarkId = leftId === coinId ? rightId : leftId;
  return {
    href: `/compare/${buildStaticComparisonSlug(leftId, rightId)}/`,
    benchmarkSymbol: CLIENT_TRACKED_META_BY_ID.get(benchmarkId)?.symbol ?? null,
  };
}
