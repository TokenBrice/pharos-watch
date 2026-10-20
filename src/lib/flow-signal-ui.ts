import { MINT_PRESSURE_TONE_CLASSES } from "@shared/lib/classification";
import type { GaugeBand } from "@shared/lib/mint-burn-gauge-bands";
import type {
  NetFlowDirection24h,
  PressureShiftState,
} from "@shared/lib/mint-burn-signals";

/** `unavailable`: partial valuation leaves the 24h direction unproven (`null` on the wire or proven-direction helper). */
type FlowDirectionKey = NetFlowDirection24h | "unavailable";

interface FlowDirectionBase {
  badgeClass: string;
  valueClass: string;
}

interface FlowPressureBase {
  badgeClass: string;
  valueClass: string;
}

export interface FlowDirectionUi extends FlowDirectionBase {
  label: string;
}

export interface FlowPressureUi extends FlowPressureBase {
  label: string;
  helper: string;
}

const FLOW_DIRECTION_BASE: Record<FlowDirectionKey, FlowDirectionBase> = {
  minting: {
    badgeClass: MINT_PRESSURE_TONE_CLASSES["mint-dominated"].badge,
    valueClass: MINT_PRESSURE_TONE_CLASSES["mint-dominated"].value,
  },
  burning: {
    badgeClass: MINT_PRESSURE_TONE_CLASSES["burn-dominated"].badge,
    valueClass: MINT_PRESSURE_TONE_CLASSES["burn-dominated"].value,
  },
  flat: {
    badgeClass: "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
  },
  inactive: {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
  },
  unavailable: {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
  },
};

const FLOW_DIRECTION_LABELS: Record<FlowDirectionKey, string> = {
  minting: "Minting",
  burning: "Burning",
  flat: "Flat",
  inactive: "No activity",
  unavailable: "Direction unavailable",
};

const FLOW_PRESSURE_BASE: Record<PressureShiftState, FlowPressureBase> = {
  improving: {
    badgeClass: MINT_PRESSURE_TONE_CLASSES["mint-dominated"].badge,
    valueClass: MINT_PRESSURE_TONE_CLASSES["mint-dominated"].value,
  },
  stable: {
    badgeClass: "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
  },
  worsening: {
    badgeClass: MINT_PRESSURE_TONE_CLASSES["burn-dominated"].badge,
    valueClass: MINT_PRESSURE_TONE_CLASSES["burn-dominated"].value,
  },
  nr: {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
  },
};

const FLOW_PRESSURE_LABELS: Record<PressureShiftState, string> = {
  improving: "Improving",
  stable: "Stable vs 30D",
  worsening: "Worsening",
  nr: "NR",
};

const FLOW_PRESSURE_HELPERS: Record<PressureShiftState, string> = {
  improving: "Current pressure is lighter than this coin's recent norm.",
  stable: "Current pressure is close to the 30-day baseline.",
  worsening: "Current pressure is harsher than the recent baseline.",
  nr: "Needs at least 7 tracked days plus current activity.",
};

export function getFlowDirectionUi(
  direction: NetFlowDirection24h | null,
): FlowDirectionUi {
  const key: FlowDirectionKey = direction ?? "unavailable";
  return {
    ...FLOW_DIRECTION_BASE[key],
    label: FLOW_DIRECTION_LABELS[key],
  };
}

export function getFlowPressureUi(
  pressureState: PressureShiftState,
): FlowPressureUi {
  return {
    ...FLOW_PRESSURE_BASE[pressureState],
    label: FLOW_PRESSURE_LABELS[pressureState],
    helper: FLOW_PRESSURE_HELPERS[pressureState],
  };
}

export function buildFlowSummaryNarrative(
  direction: NetFlowDirection24h | null,
  pressureState: PressureShiftState,
): string {
  if (direction === null) {
    return "Net direction unavailable: unpriced events leave the 24h net unproven.";
  }
  if (direction === "inactive") {
    return "No current activity; pressure shift is NR.";
  }

  if (pressureState === "nr") {
    if (direction === "burning") {
      return "Burning now; pressure shift is NR until enough history accumulates.";
    }
    if (direction === "minting") {
      return "Minting now; pressure shift is NR until enough history accumulates.";
    }
    return "Flows are flat; pressure shift is NR until enough history accumulates.";
  }

  if (direction === "burning" && pressureState === "improving") {
    return "Burning, but pressure is easing versus its baseline.";
  }
  if (direction === "burning" && pressureState === "stable") {
    return "Burning at roughly its usual redemption pace.";
  }
  if (direction === "burning" && pressureState === "worsening") {
    return "Burning, with pressure worsening versus the baseline.";
  }
  if (direction === "minting" && pressureState === "improving") {
    return "Minting, with issuance running stronger than its usual pace.";
  }
  if (direction === "minting" && pressureState === "stable") {
    return "Minting at roughly its usual 30D issuance pace.";
  }
  if (direction === "minting" && pressureState === "worsening") {
    return "Minting, but weaker than its usual 30D issuance pace.";
  }
  if (pressureState === "improving") {
    return "Flows are flat, but pressure is stronger than the baseline.";
  }
  if (pressureState === "stable") {
    return "Flows are flat and close to the baseline.";
  }
  return "Flows are flat, but pressure is weaker than the baseline.";
}

const GAUGE_BAND_VERDICTS: Record<GaugeBand, string> = {
  CRISIS: "Weighted pressure is at crisis levels against the 30-day norm.",
  STRESS: "Weighted redemption pressure is heavy against the 30-day norm.",
  CAUTIOUS: "Weighted pressure is elevated against the 30-day norm.",
  NEUTRAL: "Weighted pressure is in line with the 30-day norm.",
  HEALTHY: "Weighted issuance is running ahead of the 30-day norm.",
  CONFIDENT: "Weighted issuance is running well ahead of the 30-day norm.",
  SURGE: "Weighted issuance is surging against the 30-day norm.",
};

function joinSymbols(symbols: readonly string[]): string {
  return symbols.length === 2 ? `${symbols[0]} and ${symbols[1]}` : symbols[0];
}

/**
 * The hero's one-sentence read (at most 25 words), built only from structured
 * fields: the published band, then the coins with the largest weighted pull on
 * the score (`selectRunLineDrivers`), when per-coin weights are published. An
 * unsettled band (withheld weight could cross an edge) drops the band sentence.
 */
export function buildGaugeVerdict(
  band: GaugeBand | "unsettled" | null,
  drivers: { down: readonly { symbol: string }[]; up: readonly { symbol: string }[] },
): string {
  if (band == null) return "No weighted coin has the history and fully valued 24h flow needed to score.";
  const down = drivers.down.map((tick) => tick.symbol);
  const up = drivers.up.map((tick) => tick.symbol);
  const pulls = [
    down.length > 0 ? `${joinSymbols(down)} ${down.length === 1 ? "pulls" : "pull"} it down most` : null,
    up.length > 0 ? `${joinSymbols(up)} ${up.length === 1 ? "lifts" : "lift"} it most` : null,
  ].filter((part): part is string => part != null);
  const pullSentence = pulls.length > 0 ? `${pulls.join("; ")}.` : null;
  if (band === "unsettled") {
    return pullSentence ?? "Weight withheld for valuation could move the gauge across a band edge, so no band is claimed.";
  }
  return pullSentence ? `${GAUGE_BAND_VERDICTS[band]} ${pullSentence}` : GAUGE_BAND_VERDICTS[band];
}
