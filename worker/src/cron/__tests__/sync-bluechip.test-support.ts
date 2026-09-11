import type { BluechipRating, BluechipSmidge } from "@shared/types/market";

type Category = { translations?: Array<{ summary?: string }> } | null;
type ApiCoin = {
  grade: BluechipRating["grade"];
  collateralization?: number;
  smart_contract_audit?: boolean;
  date_of_rating?: string | null;
  date_last_change?: string | null;
} & Partial<Record<keyof BluechipSmidge, Category>>;

export function bluechipResponse(overrides: Partial<ApiCoin> = {}) {
  return { data: [{
    grade: "A", collateralization: 95, smart_contract_audit: true,
    date_of_rating: "2026-03-01", date_last_change: "2026-02-15",
    ...overrides,
  }] };
}
