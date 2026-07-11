import type { PegCurrency } from "../types/core";

export const TELEGRAM_PRESET_IDS = [
  "usd-top10",
  "usd-top25",
  "usd-top50",
  "non-usd-top10",
  "non-usd-top25",
  "non-usd-top50",
  "eur-top10",
  "gold-top5",
  "mcap-ge-1b",
  "mcap-ge-100m",
] as const;

export type TelegramPresetId = (typeof TELEGRAM_PRESET_IDS)[number];

export interface TelegramPresetDefinition {
  id: TelegramPresetId;
  label: string;
  description: string;
  category: "peg-leaders" | "market-cap";
  kind: "peg-top" | "market-cap";
  pegCurrency?: PegCurrency;
  excludePegCurrency?: PegCurrency;
  topN?: number;
  minMarketCapUsd?: number;
}

export const TELEGRAM_PRESET_DEFINITIONS: readonly TelegramPresetDefinition[] = Object.freeze([
  {
    id: "usd-top10",
    label: "USD Top 10",
    description: "Top 10 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 10,
  },
  {
    id: "usd-top25",
    label: "USD Top 25",
    description: "Top 25 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 25,
  },
  {
    id: "usd-top50",
    label: "USD Top 50",
    description: "Top 50 USD stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 50,
  },
  {
    id: "non-usd-top10",
    label: "Non-USD Top 10",
    description: "Top 10 non-USD pegs (fiat, gold/silver, baskets) by USD market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 10,
  },
  {
    id: "non-usd-top25",
    label: "Non-USD Top 25",
    description: "Top 25 non-USD pegs (fiat, gold/silver, baskets) by USD market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 25,
  },
  {
    id: "non-usd-top50",
    label: "Non-USD Top 50",
    description: "Top 50 non-USD pegs (fiat, gold/silver, baskets) by USD market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 50,
  },
  {
    id: "eur-top10",
    label: "EUR Top 10",
    description: "Top EUR stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "EUR",
    topN: 10,
  },
  {
    id: "gold-top5",
    label: "Gold Top 5",
    description: "Top gold-pegged stablecoins by current market cap.",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "GOLD",
    topN: 5,
  },
  {
    id: "mcap-ge-1b",
    label: "Market Cap >= $1B",
    description: "Tracked stablecoins with current market cap at or above $1B.",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 1_000_000_000,
  },
  {
    id: "mcap-ge-100m",
    label: "Market Cap >= $100M",
    description: "Tracked stablecoins with current market cap at or above $100M.",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 100_000_000,
  },
]);

export const TELEGRAM_PRESET_LABEL_BY_ID: ReadonlyMap<TelegramPresetId, string> = new Map(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition.label] as const),
);
