import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins";
import type {
  DependencyWeight,
  ReportCard,
  ReserveSlice,
} from "@shared/types";
import type { PortfolioHolding } from "./portfolio-codec";

export interface UpstreamExposure {
  coinId: string;
  name: string;
  symbol: string;
  usd: number;
  pct: number;
  isCollateral: boolean;
}

const STABLECOIN_SLICE_KEYWORDS = [
  "usdc",
  "usdt",
  "dai",
  "usds",
  "busd",
  "frax",
  "stablecoin",
  "stable",
];

const PORTFOLIO_META_BY_ID = new Map(
  ACTIVE_STABLECOINS.map((stablecoin) => [
    stablecoin.id,
    {
      name: stablecoin.name,
      symbol: stablecoin.symbol,
      backing: stablecoin.flags.backing,
      reserves: stablecoin.reserves,
    },
  ]),
);

const COLLATERAL_CATEGORIES: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /treasury|treasuries|t-bill|tbill|buidl|usyc|ustb|openeden|repo|money.market|wm.*m0|m0.*wm|ishares.*treasury|government.money.market|government.securities/i,
    label: "U.S. Treasury Bills",
  },
  {
    pattern: /\beur\b|euro.*deposit|euro.*cash|euro.*bond|eu.*gov|european.*asset|european.*bank|societe.generale|arion.bank|lhv.bank|swissquote|flowbank/i,
    label: "EUR / European Assets",
  },
  {
    pattern: /\bcash\b|cash.deposit|bank.deposit|bank.*deposit|cash.equivalent|fiat.usd|bny.mellon|usd.*bank|segregated.*cash|cash.*custody|cash.in.bankrupt/i,
    label: "USD Cash Deposits",
  },
  {
    pattern: /delta.hedged|spot.crypto|perpetual|\bperp\b|basis.trad|short.futures|short.perp|funding.trad/i,
    label: "Delta-Neutral Positions",
  },
  {
    pattern: /\bbtc(?!-margined)\b|bitcoin|wbtc|cbbtc|tbtc|fbtc|solvbtc|kbtc|ubtc/i,
    label: "Bitcoin (BTC)",
  },
  {
    pattern: /\bweth\b|wsteth|steth|lseth|\breth\b|liquid.*stak.*eth|eth.*liquid|\beth\b/i,
    label: "ETH / Liquid Staking",
  },
  {
    pattern: /silver/i,
    label: "Physical Silver",
  },
  {
    pattern: /\bgold\b|lbma|gold.bullion|pamp.*gold|tokenized.*gold/i,
    label: "Physical Gold",
  },
  {
    pattern: /morpho|aave|euler|pendle|curve.*lp|yearn|lp.token|lending.position|vault.share|fraxlend|compound/i,
    label: "DeFi Collateral",
  },
  {
    pattern: /\bsol\b|\bbnb\b|\bavax\b|\bdot\b|\bsui\b|\bxtz\b|\bhype\b|\bsnx\b/i,
    label: "Other Crypto",
  },
];

const MAJOR_CENTRALIZED_IDS = new Set([
  "usdt-tether",
  "usdc-circle",
  "usdp-paxos",
  "fdusd-first-digital",
  "pyusd-paypal",
  "usdy-ondo-finance",
  "buidl-blackrock",
  "usds-sky",
  "m-m0",
  "usdtb-ethena",
  "usyc-hashnote",
  "tbill-openeden",
]);

function isStablecoinSlice(name: string): boolean {
  const lower = name.toLowerCase();
  return STABLECOIN_SLICE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function collateralKey(name: string): string {
  return `__collateral_${name.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`;
}

function backingFallback(backing: string): { name: string; symbol: string } {
  if (backing === "algorithmic") {
    return { name: "Algorithmic Mechanism", symbol: "ALGO" };
  }
  if (backing === "crypto-backed") {
    return { name: "Crypto Collateral", symbol: "CRYPTO" };
  }
  return { name: "Real-World Assets (RWA)", symbol: "RWA" };
}

export function categorizeCollateral(name: string): string {
  for (const { pattern, label } of COLLATERAL_CATEGORIES) {
    if (pattern.test(name)) return label;
  }
  return "Other RWA";
}

export function computeGroupedExposure(
  raw: readonly UpstreamExposure[],
  totalUsd: number,
): UpstreamExposure[] {
  let majorUsd = 0;
  const stablecoinEntries: UpstreamExposure[] = [];

  for (const entry of raw) {
    if (entry.isCollateral) continue;
    if (MAJOR_CENTRALIZED_IDS.has(entry.coinId)) {
      majorUsd += entry.usd;
      continue;
    }
    stablecoinEntries.push(entry);
  }

  if (majorUsd > 0) {
    stablecoinEntries.unshift({
      coinId: "__group_major_centralized__",
      name: "Major Centralized Stablecoins",
      symbol: "",
      usd: majorUsd,
      pct: totalUsd > 0 ? (majorUsd / totalUsd) * 100 : 0,
      isCollateral: false,
    });
  }

  const categoryMap = new Map<string, { usd: number }>();
  for (const entry of raw) {
    if (!entry.isCollateral) continue;
    const category = categorizeCollateral(entry.name);
    const existing = categoryMap.get(category);
    if (existing) {
      existing.usd += entry.usd;
      continue;
    }
    categoryMap.set(category, { usd: entry.usd });
  }

  const collateralEntries: UpstreamExposure[] = Array.from(
    categoryMap.entries(),
    ([category, { usd }]) => ({
      coinId: `__category_${category.toLowerCase().replace(/[^a-z0-9]/g, "_")}__`,
      name: category,
      symbol: category,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: true,
    }),
  );

  collateralEntries.sort((a, b) => b.usd - a.usd);
  return [...stablecoinEntries, ...collateralEntries];
}

export function computeUpstreamExposure(
  holdings: readonly PortfolioHolding[],
  cards: readonly ReportCard[],
): UpstreamExposure[] {
  const cardMap = new Map(cards.map((card) => [card.id, card]));
  const stablecoinUsd = new Map<string, number>();
  const collateralUsd = new Map<string, { name: string; symbol: string; usd: number }>();

  function addCollateral(name: string, symbol: string, usd: number): void {
    if (usd < 0.01) return;
    const key = collateralKey(name);
    const existing = collateralUsd.get(key);
    if (existing) {
      existing.usd += usd;
      return;
    }
    collateralUsd.set(key, { name, symbol, usd });
  }

  function applyReservesToRemainder(
    reserves: ReserveSlice[],
    remainderUsd: number,
    backing: string,
  ): void {
    const nonStableReserves = reserves.filter(
      (reserve) => !isStablecoinSlice(reserve.name),
    );
    if (nonStableReserves.length === 0) {
      const fallback = backingFallback(backing);
      addCollateral(fallback.name, fallback.symbol, remainderUsd);
      return;
    }

    const totalPct = nonStableReserves.reduce(
      (sum, reserve) => sum + reserve.pct,
      0,
    );
    for (const reserve of nonStableReserves) {
      addCollateral(
        reserve.name,
        reserve.name,
        remainderUsd * (reserve.pct / totalPct),
      );
    }
  }

  for (const holding of holdings) {
    const dependencies: DependencyWeight[] =
      cardMap.get(holding.coinId)?.rawInputs?.dependencies ?? [];
    const meta = PORTFOLIO_META_BY_ID.get(holding.coinId);
    const backing = meta?.backing ?? "rwa-backed";
    const reserves = meta?.reserves;

    if (dependencies.length === 0) {
      if (reserves && reserves.length > 0) {
        const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
        for (const reserve of reserves) {
          addCollateral(
            reserve.name,
            reserve.name,
            holding.amount * (reserve.pct / totalPct),
          );
        }
      } else {
        const fallback = backingFallback(backing);
        addCollateral(fallback.name, fallback.symbol, holding.amount);
      }
      continue;
    }

    let allocatedWeight = 0;
    for (const dependency of dependencies) {
      const dependencyUsd = holding.amount * dependency.weight;
      if (PORTFOLIO_META_BY_ID.has(dependency.id)) {
        stablecoinUsd.set(
          dependency.id,
          (stablecoinUsd.get(dependency.id) ?? 0) + dependencyUsd,
        );
      }
      allocatedWeight += dependency.weight;
    }

    const remainder = 1 - allocatedWeight;
    if (remainder <= 0.001) continue;

    const remainderUsd = holding.amount * remainder;
    if (reserves && reserves.length > 0) {
      applyReservesToRemainder(reserves, remainderUsd, backing);
    } else {
      const fallback = backingFallback(backing);
      addCollateral(fallback.name, fallback.symbol, remainderUsd);
    }
  }

  const totalUsd = holdings.reduce((sum, holding) => sum + holding.amount, 0);
  const result: UpstreamExposure[] = [];

  for (const [coinId, usd] of stablecoinUsd) {
    const meta = PORTFOLIO_META_BY_ID.get(coinId);
    if (!meta) continue;
    result.push({
      coinId,
      name: meta.name,
      symbol: meta.symbol,
      usd,
      pct: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
      isCollateral: false,
    });
  }

  for (const [coinId, collateral] of collateralUsd) {
    result.push({
      coinId,
      name: collateral.name,
      symbol: collateral.symbol,
      usd: collateral.usd,
      pct: totalUsd > 0 ? (collateral.usd / totalUsd) * 100 : 0,
      isCollateral: true,
    });
  }

  result.sort((a, b) => {
    if (a.isCollateral !== b.isCollateral) {
      return a.isCollateral ? 1 : -1;
    }
    return b.usd - a.usd;
  });

  return result;
}
