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
  /**
   * Optional runtime resolver for dynamic presets (e.g. the user's watchlist).
   * When present, callers should prefer this over the static `coins` so the
   * preset reflects current client state. Returns an empty array during SSR
   * if the source isn't available yet.
   */
  getCoinsAtRuntime?: () => readonly string[];
}
