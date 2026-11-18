import { AlertTriangle, Archive, CalendarClock, OctagonAlert, PauseCircle, Radar } from "lucide-react";
import {
  COIN_STATE_LABELS,
  COIN_STATE_TONES,
  DDR_TIER_LABELS,
  getDdrTierVocabulary,
  THREAT_BAND_LABELS,
  THREAT_BAND_STYLES,
} from "@shared/lib/classification";
import type { CoinState, CoinStateKind } from "@shared/lib/coin-state";
import { formatDeviationBps } from "@shared/lib/format";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

const ICONS: Record<CoinStateKind, typeof AlertTriangle> = {
  frozen: Archive,
  delisted: Archive,
  quarantined: Archive,
  "pre-launch": Archive,
  critical: OctagonAlert,
  depeg: AlertTriangle,
  paused: PauseCircle,
  dews: Radar,
  deadline: CalendarClock,
};

/** A state's tone in one slot: DEWS states keep their band ladder, every other state its severity tone. */
export function coinStateToneClass(state: CoinState, slot: "pill" | "text"): string {
  if (state.kind === "dews") return slot === "pill" ? THREAT_BAND_STYLES[state.band].cls : THREAT_BAND_STYLES[state.band].textCls;
  return SEVERITY_TONE_CLASS[COIN_STATE_TONES[state.kind]][slot];
}

/** A state's chip label and its one-line specifics (null when the label says it all); a linked venue's state names the venue first. */
export function describeCoinState(state: CoinState): { label: string; detail: string | null } {
  const { label, detail } = describeStateSpecifics(state);
  if (state.venue === undefined) return { label, detail };
  return { label, detail: detail === null ? `Venue ${state.venue}` : `Venue ${state.venue}: ${detail}` };
}

function describeStateSpecifics(state: CoinState): { label: string; detail: string | null } {
  switch (state.kind) {
    case "critical":
    case "paused":
      return { label: COIN_STATE_LABELS[state.kind], detail: state.notice.title };
    case "depeg": {
      const parts: string[] = [];
      if (state.deviationBps !== null && state.deviationBps !== 0) {
        parts.push(`${formatDeviationBps(state.deviationBps)} ${state.deviationBps < 0 ? "below" : "above"} peg`);
      }
      if (state.ddrTier) {
        parts.push(DDR_TIER_LABELS[getDdrTierVocabulary(state.ddrMethodologyVersion)][state.ddrTier].label);
      }
      return { label: COIN_STATE_LABELS.depeg, detail: parts.length > 0 ? parts.join(" · ") : null };
    }
    case "dews":
      return { label: `${COIN_STATE_LABELS.dews} ${THREAT_BAND_LABELS[state.band]}`, detail: null };
    case "deadline": {
      const days = state.daysToDeadline;
      const when = days < 0 ? `passed ${state.notice.deadline}` : days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`;
      return { label: COIN_STATE_LABELS.deadline, detail: `${when} · ${state.notice.title}` };
    }
    default:
      return { label: COIN_STATE_LABELS[state.kind], detail: null };
  }
}

/**
 * The one compact chip for a coin's exceptional state (`resolveCoinState`).
 * The label is always visible text, never colour alone; the specifics ride in
 * the tooltip and accessible name, or inline with `showDetail` where a
 * surface has room for them.
 */
export function CoinStateChip({
  state,
  showDetail = false,
  className,
}: {
  state: CoinState;
  showDetail?: boolean;
  className?: string;
}) {
  const { label, detail } = describeCoinState(state);
  const tone = coinStateToneClass(state, "pill");
  const Icon = ICONS[state.kind];
  return (
    <span
      data-coin-state={state.kind}
      title={detail ? `${label} · ${detail}` : label}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium leading-tight",
        showDetail ? "text-pretty" : "whitespace-nowrap",
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span>{showDetail && detail ? `${label} · ${detail}` : label}</span>
      {!showDetail && detail ? <span className="sr-only">: {detail}</span> : null}
    </span>
  );
}
