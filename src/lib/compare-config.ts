import {
  CLIENT_ACTIVE_IDS,
  CLIENT_TRACKED_STABLECOINS,
} from "@shared/lib/stablecoins/client-registry";
import type { CoinOption, ComparePreset } from "@/lib/compare-types";
import { decodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";
import { readWatchlistSnapshot } from "@/lib/watchlist-storage";

export const MAX_COMPARE_COINS = 5;
export const COMPARE_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"] as const;

const CLIENT_COMPARABLE_STABLECOINS = CLIENT_TRACKED_STABLECOINS.filter(
  (coin) => CLIENT_ACTIVE_IDS.has(coin.id) || coin.status === "frozen",
);

export const COMPARE_COIN_OPTIONS: CoinOption[] = CLIENT_COMPARABLE_STABLECOINS.map((c) => ({
  id: c.id,
  name: c.name,
  symbol: c.symbol,
  frozen: c.status === "frozen",
  frozenAt: c.frozenAt,
}));

export const ID_TO_COMPARE_COIN = new Map<string, CoinOption>(
  COMPARE_COIN_OPTIONS.map((option) => [option.id, option]),
);

/**
 * Build the dynamic "My Watchlist" coin list from the unified watchlist
 * snapshot, filtered against the known compare coin set so frozen/unknown
 * coins are dropped without surfacing broken entries.
 */
function resolveWatchlistPresetCoins(): readonly string[] {
  return readWatchlistSnapshot()
    .filter((id) => ID_TO_COMPARE_COIN.has(id))
    .slice(0, MAX_COMPARE_COINS);
}

export const COMPARISON_PRESETS: readonly ComparePreset[] = [
  {
    title: "My Watchlist",
    description: "Coins you've starred across the dashboard",
    coins: [],
    getCoinsAtRuntime: resolveWatchlistPresetCoins,
  },
  {
    title: "The Big Four",
    description: "The four largest USD stablecoins by market cap",
    coins: ["usdt-tether", "usdc-circle", "usds-sky", "usde-ethena"],
  },
  {
    title: "DeFi Natives",
    description: "Decentralized, crypto-backed stablecoins",
    coins: ["dai-makerdao", "lusd-liquity", "bold-liquity"],
  },
  {
    title: "Gold Pegs",
    description: "Tokenized gold stablecoins",
    coins: ["paxg-paxos", "xaut-tether", "kau-kinesis"],
  },
  {
    title: "Euro Stablecoins",
    description: "EUR-pegged stablecoins",
    coins: ["eurs-stasis", "eure-monerium", "eurc-circle"],
  },
  {
    title: "Tokenized Treasuries",
    description: "NAV-priced tokens backed by U.S. Treasury bills",
    coins: ["usyc-hashnote", "usdy-ondo-finance", "ustb-superstate", "buidl-blackrock"],
  },
  {
    title: "Protocol Stablecoins",
    description: "Native stablecoins issued by major DeFi protocols",
    coins: ["gho-aave", "crvusd-curve", "frax-frax"],
  },
  {
    title: "Institutional RWA",
    description: "Tokenized real-world assets from institutional issuers",
    coins: ["buidl-blackrock", "m-m0", "usd0-usual"],
  },
  {
    title: "Emerging Currency Pegs",
    description: "Stablecoins pegged to emerging market fiat currencies",
    coins: ["brz-transfero", "zarp-zarp"],
  },
  {
    title: "Non-USD Majors",
    description: "Stablecoins pegged to developed-market non-USD currencies",
    coins: ["xsgd-straitsx", "jpyc-jpyc", "zchf-frankencoin"],
  },
] as const;

/**
 * Resolve a preset's coin list, preferring the runtime resolver when present.
 * Returns the static `coins` for built-in presets and the dynamic snapshot for
 * presets like "My Watchlist".
 */
export function getPresetCoins(preset: ComparePreset): readonly string[] {
  return preset.getCoinsAtRuntime ? preset.getCoinsAtRuntime() : preset.coins;
}

export function resolveCompareSelectedIds(param: string | null): string[] {
  if (!param) return [];
  return param
    .split(",")
    .map((segment) => {
      const trimmed = segment.trim();
      const decodedId = decodeStablecoinUrlToken(trimmed);
      return decodedId ? (ID_TO_COMPARE_COIN.get(decodedId) ?? null) : null;
    })
    .filter((coin): coin is CoinOption => coin != null)
    .slice(0, MAX_COMPARE_COINS)
    .map((coin) => coin.id);
}
