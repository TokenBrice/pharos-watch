// ---------------------------------------------------------------------------
// buildBriefing — pure function that converts structured market data into
// human-readable intelligence briefing text.
//
// Consumed by the Intelligence Briefing component (Task 6).
// No React, no hooks, no API calls — pure in, pure out.
// ---------------------------------------------------------------------------

export interface BriefingPsiInput {
  score: number;
  band: string;
  delta24h: number;
  delta7d: number;
  daysInBand: number;
}

export interface BriefingDepegInput {
  activeCount: number;
  activeCoins: Array<{ symbol: string; bps: number }>;
  lastClosedCoin: string | null;
  lastClosedDaysAgo: number | null;
  lastClosedBps: number | null;
}

export interface BriefingDewsInput {
  dangerCount: number;
  alertCount: number;
  warningCount: number;
  topStressed: Array<{ symbol: string; band: string }>;
}

export interface BriefingFlowsInput {
  net24hUsd: number;
  direction: "minting" | "burning" | "neutral";
  isStrongestIn7d: boolean;
  ftqTriggered: boolean;
  bankRunElevated: boolean;
}

export interface BriefingInput {
  psi: BriefingPsiInput;
  depegs: BriefingDepegInput;
  dews: BriefingDewsInput;
  flows: BriefingFlowsInput;
}

export type BriefingTone =
  | "confident"
  | "calm"
  | "watchful"
  | "alert"
  | "urgent"
  | "emergency";

export interface BriefingLine {
  type: "depegs" | "stress" | "flows" | "calm-summary" | "extra";
  text: string;
}

export interface BriefingOutput {
  headline: string;
  bandKeyword: string;
  tone: BriefingTone;
  lines: BriefingLine[];
}

// ---------------------------------------------------------------------------
// Band → headline stem / tone mappings
// ---------------------------------------------------------------------------

const BAND_HEADLINES: Record<string, string> = {
  BEDROCK: "The stablecoin ecosystem is rock-solid",
  STEADY: "The stablecoin ecosystem is steady",
  TREMOR: "The stablecoin ecosystem shows minor stress",
  FRACTURE: "The stablecoin ecosystem is under pressure",
  CRISIS: "Multiple stablecoins are in distress",
  MELTDOWN: "Systemic stress across the stablecoin market",
};

const BAND_TONES: Record<string, BriefingTone> = {
  BEDROCK: "confident",
  STEADY: "calm",
  TREMOR: "watchful",
  FRACTURE: "alert",
  CRISIS: "urgent",
  MELTDOWN: "emergency",
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(0)}M`;
  return `$${abs.toLocaleString("en-US")}`;
}

function durationText(days: number): string {
  if (days > 30) return "for over a month";
  if (days === 1) return "since yesterday";
  return `day ${days} of the current run`;
}

function deltaText(delta24h: number): string {
  if (delta24h > 0) return `up ${delta24h} since yesterday`;
  if (delta24h < 0) return `down ${Math.abs(delta24h)} since yesterday`;
  return "";
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function buildBriefing(input: BriefingInput): BriefingOutput {
  const { psi, depegs, dews, flows } = input;

  // --- Headline ---
  const bandBase =
    BAND_HEADLINES[psi.band] ??
    "The stablecoin ecosystem status is unknown";
  const duration = durationText(psi.daysInBand);
  const delta = deltaText(psi.delta24h);
  const scorePart = `PSI ${psi.score} (${psi.band})`;
  const headline = [
    `${bandBase} \u2014 ${duration}.`,
    delta ? `${scorePart}, ${delta}.` : `${scorePart}.`,
  ].join(" ");

  // --- Tone ---
  const tone: BriefingTone = BAND_TONES[psi.band] ?? "calm";

  // --- Body lines ---
  const lines: BriefingLine[] = [];

  const allCalm =
    depegs.activeCount === 0 &&
    dews.dangerCount === 0 &&
    dews.alertCount === 0 &&
    dews.warningCount === 0 &&
    !depegs.lastClosedCoin;

  if (allCalm) {
    // Collapse depegs + stress into a single calm-summary line
    lines.push({
      type: "calm-summary",
      text: "All pegs stable, no stress signals.",
    });
  } else {
    // Depeg line
    if (depegs.activeCount > 0) {
      const coins = depegs.activeCoins.map((c) => c.symbol).join(", ");
      lines.push({
        type: "depegs",
        text: `${depegs.activeCount} coin${depegs.activeCount > 1 ? "s" : ""} depegged: ${coins}.`,
      });
    } else if (depegs.lastClosedCoin) {
      lines.push({
        type: "depegs",
        text: `No active depegs. Last event ended ${depegs.lastClosedDaysAgo} days ago (${depegs.lastClosedCoin}, ${depegs.lastClosedBps} bps).`,
      });
    }

    // Stress line
    if (dews.dangerCount > 0) {
      const top = dews.topStressed.map((s) => s.symbol).join(", ");
      lines.push({
        type: "stress",
        text: `DEWS signals: ${dews.dangerCount} in DANGER${top ? ` (${top})` : ""}, ${dews.alertCount} ALERT, ${dews.warningCount} WARNING.`,
      });
    } else if (dews.alertCount > 0 || dews.warningCount > 0) {
      lines.push({
        type: "stress",
        text: `DEWS signals show elevated stress on ${dews.alertCount + dews.warningCount} coin${dews.alertCount + dews.warningCount > 1 ? "s" : ""}.`,
      });
    }
  }

  // Flows line
  const flowAmount = formatUsd(flows.net24hUsd);
  const flowDir =
    flows.direction === "minting"
      ? "Net minting"
      : flows.direction === "burning"
        ? "Net burning"
        : "Balanced flows";
  const anchor = flows.isStrongestIn7d
    ? ` \u2014 the strongest ${flows.direction} day in 7 days`
    : "";
  lines.push({
    type: "flows",
    text: `${flowDir} of ${flowAmount} in 24h${anchor}.`,
  });

  // Extra line (optional signals)
  if (flows.ftqTriggered) {
    lines.push({
      type: "extra",
      text: "Flight-to-quality in progress \u2014 capital rotating between stablecoins.",
    });
  } else if (flows.bankRunElevated) {
    lines.push({
      type: "extra",
      text: "Bank run gauge elevated \u2014 aggregate redemption pressure above baseline.",
    });
  }

  return { headline, bandKeyword: psi.band, tone, lines };
}
