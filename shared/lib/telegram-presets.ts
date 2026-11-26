import type { PegCurrency } from "../types/core";

interface TelegramPresetDefinitionShape {
  label: string;
  description: string;
  category: "peg-leaders" | "market-cap";
  kind: "peg-top" | "market-cap";
  pegCurrency?: PegCurrency;
  excludePegCurrency?: PegCurrency;
  topN?: number;
  minMarketCapUsd?: number;
}

export const TELEGRAM_PRESET_DEFINITIONS = Object.freeze([
  {
    id: "usd-top10",
    label: "USD Top 10",
    description: "The 10 largest USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 10,
  },
  {
    id: "usd-top25",
    label: "USD Top 25",
    description: "The 25 largest USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 25,
  },
  {
    id: "usd-top50",
    label: "USD Top 50",
    description: "The 50 largest USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "USD",
    topN: 50,
  },
  {
    id: "non-usd-top10",
    label: "Non-USD Top 10",
    description: "The 10 largest non-USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 10,
  },
  {
    id: "non-usd-top25",
    label: "Non-USD Top 25",
    description: "The 25 largest non-USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 25,
  },
  {
    id: "non-usd-top50",
    label: "Non-USD Top 50",
    description: "The 50 largest non-USD stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    excludePegCurrency: "USD",
    topN: 50,
  },
  {
    id: "eur-top10",
    label: "EUR Top 10",
    description: "The 10 largest euro stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "EUR",
    topN: 10,
  },
  {
    id: "gold-top5",
    label: "Gold Top 5",
    description: "The 5 largest gold-backed stablecoins by market cap",
    category: "peg-leaders",
    kind: "peg-top",
    pegCurrency: "GOLD",
    topN: 5,
  },
  {
    id: "mcap-ge-1b",
    label: "Over $1B",
    description: "Tracked stablecoins at or above $1B market cap",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 1_000_000_000,
  },
  {
    id: "mcap-ge-100m",
    label: "Over $100M",
    description: "Tracked stablecoins at or above $100M market cap",
    category: "market-cap",
    kind: "market-cap",
    minMarketCapUsd: 100_000_000,
  },
] as const satisfies readonly (TelegramPresetDefinitionShape & { id: string })[]);

export type TelegramPresetId = (typeof TELEGRAM_PRESET_DEFINITIONS)[number]["id"];

export type TelegramPresetDefinition = TelegramPresetDefinitionShape & {
  id: TelegramPresetId;
};

export const TELEGRAM_PRESET_IDS = TELEGRAM_PRESET_DEFINITIONS.map(
  ({ id }) => id,
) as readonly TelegramPresetId[];

export const TELEGRAM_PRESET_DEFINITION_BY_ID: ReadonlyMap<TelegramPresetId, TelegramPresetDefinition> = new Map(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition] as const),
);

export const TELEGRAM_PRESET_LABEL_BY_ID: ReadonlyMap<TelegramPresetId, string> = new Map(
  TELEGRAM_PRESET_DEFINITIONS.map((definition) => [definition.id, definition.label] as const),
);
