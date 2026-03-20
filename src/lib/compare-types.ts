export interface CoinOption {
  id: string;
  name: string;
  symbol: string;
}

export interface ComparePreset {
  title: string;
  description: string;
  coins: readonly string[];
}
