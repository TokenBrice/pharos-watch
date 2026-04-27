export interface CoinOption {
  id: string;
  name: string;
  symbol: string;
  frozen?: boolean;
  frozenAt?: string;
}

export interface ComparePreset {
  title: string;
  description: string;
  coins: readonly string[];
}
