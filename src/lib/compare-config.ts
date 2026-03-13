import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import type { CoinOption } from "@/components/coin-selector";
import type { ComparePreset } from "@/components/compare-empty-state";
import { decodeStablecoinUrlToken } from "@/lib/stablecoin-url-codec";

export const MAX_COMPARE_COINS = 5;
export const COMPARE_COLORS = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6"] as const;

export const COMPARE_COIN_OPTIONS: CoinOption[] = TRACKED_STABLECOINS.map((c) => ({
  id: c.id,
  name: c.name,
  symbol: c.symbol,
}));

export const ID_TO_COMPARE_COIN = new Map<string, CoinOption>(
  TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    { id: coin.id, name: coin.name, symbol: coin.symbol },
  ]),
);

export const COMPARISON_PRESETS: readonly ComparePreset[] = [
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
    coins: ["usyc-hashnote", "usdy-ondo-finance", "tbill-openeden", "buidl-blackrock"],
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
    coins: ["xsgd-straitsx", "gyen-gyen", "zchf-frankencoin"],
  },
] as const;

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
