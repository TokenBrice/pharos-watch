import type {
  NetFlowDirection24h,
  PressureShiftState,
} from "@shared/lib/mint-burn-signals";

type FlowSignalVariant = "summary" | "overview";
type FlowSceneMode = "printer" | "shredder";

interface FlowDirectionBase {
  badgeClass: string;
  valueClass: string;
  accentHex: string;
  sceneMode: FlowSceneMode;
}

interface FlowPressureBase {
  badgeClass: string;
  valueClass: string;
  headlineClass: string;
  panelClass: string;
}

export interface FlowDirectionUi extends FlowDirectionBase {
  label: string;
  helper: string;
  sceneTitle: string;
}

export interface FlowPressureUi extends FlowPressureBase {
  label: string;
  helper: string;
}

const FLOW_DIRECTION_BASE: Record<NetFlowDirection24h, FlowDirectionBase> = {
  minting: {
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    valueClass: "text-emerald-700 dark:text-emerald-400",
    accentHex: "#22c55e",
    sceneMode: "printer",
  },
  burning: {
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: "text-red-700 dark:text-red-400",
    accentHex: "#ef4444",
    sceneMode: "shredder",
  },
  flat: {
    badgeClass: "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
    accentHex: "#6b7280",
    sceneMode: "printer",
  },
  inactive: {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
    accentHex: "#6b7280",
    sceneMode: "printer",
  },
};

const FLOW_DIRECTION_LABELS: Record<FlowSignalVariant, Record<NetFlowDirection24h, string>> = {
  summary: {
    minting: "Minting",
    burning: "Burning",
    flat: "Flat",
    inactive: "No activity",
  },
  overview: {
    minting: "Net minting",
    burning: "Net burning",
    flat: "Flat net flow",
    inactive: "No activity",
  },
};

const FLOW_DIRECTION_SCENE_TITLES: Record<FlowSignalVariant, Record<NetFlowDirection24h, string>> = {
  summary: {
    minting: "Printer",
    burning: "Shredder",
    flat: "Flow Desk",
    inactive: "Flow Desk",
  },
  overview: {
    minting: "Mint Desk",
    burning: "Burn Desk",
    flat: "Flow Desk",
    inactive: "Flow Desk",
  },
};

const FLOW_DIRECTION_HELPERS: Record<NetFlowDirection24h, string> = {
  minting: "Net issuance dominates the last 24 hours.",
  burning: "Net redemptions dominate the last 24 hours.",
  flat: "Mints and burns offset each other in the active window.",
  inactive: "No mint or burn events were recorded in the active window.",
};

const FLOW_PRESSURE_BASE: Record<PressureShiftState, FlowPressureBase> = {
  improving: {
    badgeClass:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300",
    valueClass: "text-emerald-700 dark:text-emerald-400",
    headlineClass: "text-emerald-700 dark:text-emerald-300",
    panelClass:
      "border-emerald-600/30 bg-emerald-500/10 dark:border-emerald-500/35 dark:bg-emerald-500/10",
  },
  stable: {
    badgeClass: "border-border/70 bg-muted/40 text-foreground",
    valueClass: "text-foreground",
    headlineClass: "text-foreground",
    panelClass: "border-border/60 bg-background/55 dark:bg-background/35",
  },
  worsening: {
    badgeClass:
      "border-red-600/30 bg-red-500/10 text-red-700 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300",
    valueClass: "text-red-700 dark:text-red-400",
    headlineClass: "text-red-700 dark:text-red-300",
    panelClass:
      "border-red-600/30 bg-red-500/10 dark:border-red-500/35 dark:bg-red-500/10",
  },
  nr: {
    badgeClass: "border-border/70 bg-muted/40 text-muted-foreground",
    valueClass: "text-muted-foreground",
    headlineClass: "text-muted-foreground",
    panelClass: "border-border/60 bg-background/35",
  },
};

const FLOW_PRESSURE_LABELS: Record<FlowSignalVariant, Record<PressureShiftState, string>> = {
  summary: {
    improving: "Improving",
    stable: "Stable vs 30D",
    worsening: "Worsening",
    nr: "NR",
  },
  overview: {
    improving: "Pressure improving",
    stable: "Pressure stable",
    worsening: "Pressure worsening",
    nr: "Pressure NR",
  },
};

const FLOW_PRESSURE_HELPERS: Record<PressureShiftState, string> = {
  improving: "Current pressure is lighter than this coin's recent norm.",
  stable: "Current pressure is close to the 30-day baseline.",
  worsening: "Current pressure is harsher than the recent baseline.",
  nr: "Needs at least 7 tracked days plus current activity.",
};

export function getFlowDirectionUi(
  direction: NetFlowDirection24h,
  variant: FlowSignalVariant,
): FlowDirectionUi {
  return {
    ...FLOW_DIRECTION_BASE[direction],
    label: FLOW_DIRECTION_LABELS[variant][direction],
    helper: FLOW_DIRECTION_HELPERS[direction],
    sceneTitle: FLOW_DIRECTION_SCENE_TITLES[variant][direction],
  };
}

export function getFlowPressureUi(
  pressureState: PressureShiftState,
  variant: FlowSignalVariant,
): FlowPressureUi {
  return {
    ...FLOW_PRESSURE_BASE[pressureState],
    label: FLOW_PRESSURE_LABELS[variant][pressureState],
    helper: FLOW_PRESSURE_HELPERS[pressureState],
  };
}

export function buildFlowSummaryNarrative(
  direction: NetFlowDirection24h,
  pressureState: PressureShiftState,
): string {
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

export function buildFlowOverviewHeadline(
  direction: NetFlowDirection24h,
  pressureState: PressureShiftState,
): string {
  if (direction === "inactive") {
    return "No aggregate mint/burn activity";
  }
  if (direction === "burning" && pressureState === "improving") {
    return "Net burn day, but market pressure is easing";
  }
  if (direction === "burning" && pressureState === "stable") {
    return "Net burn day with steady pressure";
  }
  if (direction === "burning" && pressureState === "worsening") {
    return "Net burn day with worsening pressure";
  }
  if (direction === "minting" && pressureState === "improving") {
    return "Net mint day with improving pressure";
  }
  if (direction === "minting" && pressureState === "stable") {
    return "Net mint day with steady pressure";
  }
  if (direction === "minting" && pressureState === "worsening") {
    return "Minting, but softer than the 30D pace";
  }
  if (pressureState === "improving") {
    return "Balanced net flow, but pressure is improving";
  }
  if (pressureState === "stable") {
    return "Balanced net flow, neutral market pressure";
  }
  if (pressureState === "worsening") {
    return "Balanced net flow, but pressure is weakening";
  }
  return "Balanced net flow while the gauge recalibrates";
}

export function buildFlowOverviewDescription(
  direction: NetFlowDirection24h,
  pressureState: PressureShiftState,
): string {
  if (direction === "inactive") {
    return "No aggregate mint or burn events were recorded in the active 24-hour window.";
  }
  if (pressureState === "nr") {
    return "Net flow answers what the market is doing now; pressure shift is NR until enough history is available.";
  }
  return "Net flow tells you what the market is doing right now. The Bank Run Gauge tells you how unusual that pressure is versus the recent 30-day norm.";
}
