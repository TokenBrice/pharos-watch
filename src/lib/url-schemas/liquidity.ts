/**
 * URL state schema for `/liquidity/`.
 *
 * Captures the shareable filter slice consumed by `LiquidityClient`:
 * the peg-currency toggle and the free-text search query.
 *
 * No chain or range filter exists today on this surface; the schema mirrors
 * what's actually meaningful to share. Add fields here if the page grows
 * additional URL-bound state.
 *
 * `peg` is declared as `string` (not `enum`) because the canonical option set
 * is the full `PegCurrency` union; per-value validation happens in
 * `normalizePegFilter` inside `src/app/liquidity/model.ts`.
 */
import type { UrlStateSchema } from "@/lib/url-state";

export interface LiquidityUrlValues {
  /** Peg currency filter (`all`, `USD`, `EUR`, `GOLD`, ...). */
  peg: string;
  /** Free-text search query (name or symbol). */
  q: string;
}

export const LIQUIDITY_URL_SCHEMA: UrlStateSchema<LiquidityUrlValues> = {
  peg: {
    kind: "string",
    defaultValue: "all",
  },
  q: {
    kind: "string",
    defaultValue: "",
  },
};
