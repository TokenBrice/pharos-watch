import type { ChartAnnotation } from "@shared/types/chart-annotation";

/**
 * Editorially curated chart annotations for historical events that are NOT
 * automatically surfaced by the tape (regulatory bans, market-wide shocks,
 * coin launches, methodology pivots, etc.).
 *
 * Keyed by stablecoin id — must match the filename in
 * `shared/data/stablecoins/coins/<id>.json`.
 *
 * Curation rules:
 *   - One annotation per discrete event (don't collapse multi-day depegs).
 *   - Prefer the price-bottom / supply-pivot timestamp, not the press cycle.
 *   - Severity matches the tape vocabulary: `high` for grade-impacting events,
 *     `med` for non-fatal stress, `low` for context.
 *   - `href` should resolve to a primary source (issuer post-mortem, regulator
 *     filing, methodology changelog) rather than secondary press.
 *   - Keep the labels ≤80 chars; the SR-only legend lists them verbatim.
 *
 * Coverage policy: top-50 coins by market-cap target ≥1 annotation each where
 * a meaningful historical event exists. Coins without notable events stay
 * uncurated (empty / absent key is the correct state).
 */
export const CURATED_ANNOTATIONS: Record<string, readonly ChartAnnotation[]> = {
  "usdc-circle": [
    {
      ts: Date.UTC(2023, 2, 10), // 2023-03-10 — SVB closed by California DFPI / FDIC receivership
      kind: "regulatory",
      label: "Silicon Valley Bank closed by regulators",
      severity: "high",
    },
    {
      ts: Date.UTC(2023, 2, 11), // 2023-03-11 — USDC price-bottom ~$0.87 after SVB exposure disclosed
      kind: "depeg",
      label: "SVB collapse — USDC depeg low ~$0.87",
      severity: "high",
      href: "https://www.circle.com/blog/an-update-on-usdc-and-silicon-valley-bank",
    },
    {
      ts: Date.UTC(2023, 2, 13), // 2023-03-13 — Joint Treasury/Fed/FDIC depositor backstop; USDC repegs
      kind: "regulatory",
      label: "Federal depositor backstop announced — USDC repegs",
      severity: "med",
    },
  ],
  "usdt-tether": [
    {
      ts: Date.UTC(2018, 9, 15), // 2018-10-15 — USDT to ~$0.85 amid Bitfinex banking concerns (Noble Bank)
      kind: "depeg",
      label: "Bitfinex banking stress — USDT depeg low ~$0.85",
      severity: "high",
    },
    {
      ts: Date.UTC(2019, 3, 25), // 2019-04-25 — NY AG announces court order against Bitfinex/Tether (iFinex)
      kind: "regulatory",
      label: "NY AG court order vs. Bitfinex/Tether (commingling)",
      severity: "med",
    },
    {
      ts: Date.UTC(2021, 1, 23), // 2021-02-23 — NY AG settlement with Bitfinex/Tether ($18.5M)
      kind: "regulatory",
      label: "NY AG settlement with Bitfinex/Tether ($18.5M)",
      severity: "med",
    },
    {
      ts: Date.UTC(2021, 9, 15), // 2021-10-15 — CFTC order against Tether ($41M penalty)
      kind: "regulatory",
      label: "CFTC settlement order vs. Tether ($41M penalty)",
      severity: "med",
    },
  ],
  "dai-makerdao": [
    {
      ts: Date.UTC(2020, 2, 12), // 2020-03-12 — Black Thursday: ETH crash, $0-bid collateral auctions, system shortfall
      kind: "governance",
      label: "Black Thursday — collateral auctions fail, MKR backstop",
      severity: "high",
    },
    {
      ts: Date.UTC(2023, 2, 11), // 2023-03-11 — Dai depegs alongside USDC due to PSM collateral exposure
      kind: "depeg",
      label: "USDC contagion via PSM — Dai depeg low",
      severity: "high",
    },
  ],
  "usde-ethena": [
    {
      ts: Date.UTC(2024, 1, 19), // 2024-02-19 — USDe public mainnet launch
      kind: "governance",
      label: "USDe public mainnet launch",
      severity: "med",
    },
  ],
};

const EMPTY: readonly ChartAnnotation[] = [];

export function getCuratedAnnotations(stablecoinId: string): readonly ChartAnnotation[] {
  return CURATED_ANNOTATIONS[stablecoinId] ?? EMPTY;
}
