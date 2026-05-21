/**
 * URL state schema for `/compare/`.
 *
 * Captures the shareable filter slice consumed by `useCompareSelection`:
 * the selected coin IDs (CSV-joined under `coins`) and the time range
 * (`range`). `flowHours` is intentionally omitted — it's local UI state
 * for the Live Flow Signals panel, not a meaningful URL contract.
 *
 * Coin IDs are stored as an opaque CSV string (rather than `enumList`) so
 * the schema doesn't need to import the full coin registry; per-ID
 * validation lives in `src/lib/compare-config.ts::resolveCompareSelectedIds`.
 */
import type { UrlStateSchema } from "@/lib/url-state";

export type CompareRange = "7d" | "30d" | "90d" | "1y" | "all";

export const COMPARE_RANGES = ["7d", "30d", "90d", "1y", "all"] as const satisfies readonly CompareRange[];

export interface CompareUrlValues {
  /** CSV of selected coin IDs (e.g. "usdt-tether,usdc-circle"). Empty string means none. */
  coins: string;
  /** Time range for the supply-history comparison chart. */
  range: CompareRange;
}

export const COMPARE_URL_SCHEMA: UrlStateSchema<CompareUrlValues> = {
  coins: {
    kind: "string",
    defaultValue: "",
  },
  range: {
    kind: "enum",
    defaultValue: "all",
    allowedValues: COMPARE_RANGES,
  },
};
