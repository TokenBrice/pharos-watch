// DEX liquidity concentration (HHI) bands
// ---------------------------------------------------------------------------

// Reviewed concentration-band thresholds (liquidity methodology v6.6, effective 2026-09-21).
// The 2026-09 card/exit-route consolidation re-based the card's pre-dedup table (High >= 0.5,
// Medium >= 0.25) onto these boundaries; v6.6 records the re-based values as intended. This is
// the only band table in the repo — consumers import, never re-type.
const HHI_CROWDED_MIN = 0.35;
const HHI_VISIBLE_MIN = 0.18;

const HHI_BANDS = [
  {
    min: HHI_CROWDED_MIN,
    key: "crowded",
    concentrationLabel: "High",
    color: "text-red-700 dark:text-red-400",
    throatLabel: "Crowded exits",
    interpretation: "Exit depth is crowded into a small set of venues.",
  },
  {
    min: HHI_VISIBLE_MIN,
    key: "visible",
    concentrationLabel: "Medium",
    color: "text-amber-700 dark:text-amber-400",
    throatLabel: "Visible route concentration",
    interpretation: "Exit depth is usable, but route concentration is visible.",
  },
  {
    min: Number.NEGATIVE_INFINITY,
    key: "broad",
    concentrationLabel: "Low",
    color: "text-emerald-700 dark:text-emerald-400",
    throatLabel: "Broad route diversity",
    interpretation: "Exit depth is broadly distributed across venues.",
  },
] as const;

export type HhiBand = (typeof HHI_BANDS)[number];

export function getHhiBand(hhi: number): HhiBand {
  // Total: NaN fails every `>=` comparison, so a non-finite HHI degrades to the
  // broadest band instead of throwing at the card that renders it.
  return HHI_BANDS.find((band) => hhi >= band.min) ?? HHI_BANDS[HHI_BANDS.length - 1];
}
