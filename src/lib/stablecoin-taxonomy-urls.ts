import { PEG_CURRENCY_VALUES, type BackingType, type PegCurrency } from "@shared/types/core";
import type { GovernanceType, Infrastructure } from "@shared/types/stablecoin-taxonomy";

export type InfrastructureTaxonomyValue = Infrastructure;

const GOVERNANCE_SLUGS: Record<GovernanceType, string> = {
  centralized: "cefi",
  "centralized-dependent": "cefi-dependent",
  decentralized: "defi",
};

const BACKING_SLUGS: Record<BackingType, string> = {
  "rwa-backed": "rwa",
  "crypto-backed": "crypto",
  algorithmic: "algorithmic",
};

const INFRASTRUCTURE_SLUGS: Record<InfrastructureTaxonomyValue, string> = {
  "liquity-v1": "liquity-v1",
  "liquity-v2": "liquity-v2",
  m0: "m0",
};

export function buildGovernanceTaxonomyUrl(value: GovernanceType): string {
  return `/stablecoins/governance/${GOVERNANCE_SLUGS[value]}/`;
}

export function buildBackingTaxonomyUrl(value: BackingType): string {
  return `/stablecoins/backing/${BACKING_SLUGS[value]}/`;
}

export function buildInfrastructureTaxonomyUrl(value: InfrastructureTaxonomyValue): string {
  return `/stablecoins/infrastructure/${INFRASTRUCTURE_SLUGS[value]}/`;
}

export interface StablecoinTaxonomyCohort<TValue, TCoin> {
  value: TValue;
  slug: string;
  href: string;
  coins: TCoin[];
}

/**
 * The one rule for which taxonomy cohort pages exist, in display order: every
 * governance and infrastructure cohort, backing cohorts only when an active
 * coin has that backing, each kind sorted by descending membership. Pure over
 * the coins it is given, so the phase-0 sitemap-dates generator shares it.
 */
export function selectStablecoinTaxonomyCohorts<
  TCoin extends {
    flags: { governance: GovernanceType; backing: BackingType };
    infrastructures?: readonly InfrastructureTaxonomyValue[];
  },
>(activeCoins: readonly TCoin[]): {
  governance: StablecoinTaxonomyCohort<GovernanceType, TCoin>[];
  backing: StablecoinTaxonomyCohort<BackingType, TCoin>[];
  infrastructure: StablecoinTaxonomyCohort<InfrastructureTaxonomyValue, TCoin>[];
} {
  const byMembership = (left: { coins: TCoin[] }, right: { coins: TCoin[] }) => right.coins.length - left.coins.length;
  return {
    governance: (Object.keys(GOVERNANCE_SLUGS) as GovernanceType[])
      .map((value) => ({
        value,
        slug: GOVERNANCE_SLUGS[value],
        href: buildGovernanceTaxonomyUrl(value),
        coins: activeCoins.filter((coin) => coin.flags.governance === value),
      }))
      .sort(byMembership),
    backing: (Object.keys(BACKING_SLUGS) as BackingType[])
      .map((value) => ({
        value,
        slug: BACKING_SLUGS[value],
        href: buildBackingTaxonomyUrl(value),
        coins: activeCoins.filter((coin) => coin.flags.backing === value),
      }))
      .filter((cohort) => cohort.coins.length > 0)
      .sort(byMembership),
    infrastructure: (Object.keys(INFRASTRUCTURE_SLUGS) as InfrastructureTaxonomyValue[])
      .map((value) => ({
        value,
        slug: INFRASTRUCTURE_SLUGS[value],
        href: buildInfrastructureTaxonomyUrl(value),
        coins: activeCoins.filter((coin) => (coin.infrastructures ?? []).includes(value)),
      }))
      .sort(byMembership),
  };
}

/** PegCurrency → URL slug mapping shared by runtime peg hubs and build-time route generation. */
export const ALL_PEG_SLUGS: Record<PegCurrency, string> = {
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
  CZK: "czk",
  PLN: "pln",
  AED: "aed",
  NZD: "nzd",
  IDR: "idr",
  INR: "inr",
  HKD: "hkd",
  GOLD: "gold",
  SILVER: "silver",
  VAR: "cpi",
  OTHER: "other",
};

/**
 * A peg with no active coin still gets a `/stablecoins/<peg>/` hub once this
 * many pre-launch coins share it (owner decision D3, 2026-10-25). `OTHER` is
 * not a currency and never gets a hub.
 */
export const PRE_LAUNCH_HUB_MIN_COINS = 2;

/**
 * Keep the schema vocabulary authoritative while preserving the established
 * route order for currencies displayed outside their schema position.
 */
export function getPegRouteOrder(): PegCurrency[] {
  const order: PegCurrency[] = [...PEG_CURRENCY_VALUES];
  for (const [currency, before] of [
    ["SGD", "MYR"],
    ["PHP", "CNY"],
    ["RUB", "CNY"],
    ["IDR", "GOLD"],
    ["INR", "GOLD"],
    ["HKD", "GOLD"],
  ] as const) {
    order.splice(order.indexOf(currency), 1);
    order.splice(order.indexOf(before), 0, currency);
  }
  return order;
}

export function selectPegHubCurrencies({
  active,
  preLaunch,
  pegOrder = getPegRouteOrder(),
}: {
  active: ReadonlyArray<{ flags: { pegCurrency: string } }>;
  preLaunch: ReadonlyArray<{ flags: { pegCurrency: string } }>;
  pegOrder?: readonly string[];
}): {
  rawActivePegCurrencyCounts: Record<string, number>;
  activePegCurrencies: string[];
  preLaunchHubPegCurrencies: string[];
} {
  const rawActivePegCurrencyCounts: Record<string, number> = {};
  for (const coin of active) {
    const peg = coin.flags.pegCurrency;
    rawActivePegCurrencyCounts[peg] = (rawActivePegCurrencyCounts[peg] ?? 0) + 1;
  }

  const activePegCurrencies = pegOrder.filter((peg) => rawActivePegCurrencyCounts[peg] != null);
  const preLaunchPegCurrencyCounts: Record<string, number> = {};
  for (const coin of preLaunch) {
    const peg = coin.flags.pegCurrency;
    preLaunchPegCurrencyCounts[peg] = (preLaunchPegCurrencyCounts[peg] ?? 0) + 1;
  }

  const preLaunchHubPegCurrencies = pegOrder.filter(
    (peg) =>
      peg !== "OTHER"
      && rawActivePegCurrencyCounts[peg] == null
      && (preLaunchPegCurrencyCounts[peg] ?? 0) >= PRE_LAUNCH_HUB_MIN_COINS,
  );

  return {
    rawActivePegCurrencyCounts,
    activePegCurrencies,
    preLaunchHubPegCurrencies,
  };
}

/**
 * A `/chains/<id>/` profile is indexed only when at least this many tracked
 * stablecoins (each with its own profile) have a mapped contract on the
 * chain. Thinner chain pages stay live and linked from `/chains/` but serve
 * `noindex, follow` and stay out of the sitemap and public route inventory:
 * the 41 chains below the bar drew 71 impressions in three months and made
 * up most of the chain URLs in crawled-not-indexed (2026-10-25 SEO plan, NQ5).
 */
export const MIN_INDEXABLE_CHAIN_STABLECOINS = 3;

export function countStablecoinsByChain(
  stablecoins: ReadonlyArray<{ contracts?: ReadonlyArray<{ chain: string }> }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const stablecoin of stablecoins) {
    for (const chainId of new Set((stablecoin.contracts ?? []).map((contract) => contract.chain))) {
      counts.set(chainId, (counts.get(chainId) ?? 0) + 1);
    }
  }
  return counts;
}
