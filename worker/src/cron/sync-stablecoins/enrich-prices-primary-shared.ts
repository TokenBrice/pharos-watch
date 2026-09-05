export interface PriceValidationStats {
  attempted: number;
  high: number;
  singleSource: number;
  cgOnly: number;
  low: number;
}

// DefiLlama returns the literal string "wrong" as the geckoId for assets whose
// CoinGecko id could not be resolved; treat that exact sentinel as unusable.
const INVALID_GECKO_ID_SENTINEL = "wrong";

export function isUsableGeckoId(geckoId: unknown): geckoId is string {
  return typeof geckoId === "string" && geckoId.length > 0 && geckoId !== INVALID_GECKO_ID_SENTINEL;
}
