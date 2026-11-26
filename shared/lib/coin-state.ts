/**
 * The coin exceptional-state authority: one precedence ladder for "what is
 * wrong with this coin right now", shared by every surface that leads with,
 * ranks or lists a coin (the dossier lead slot and hero tones, yield,
 * portfolio, compare, screener and tables, the command palette, maps).
 *
 * Runtime-neutral and pure. Callers pass the inputs they hold; an absent input
 * never asserts a state, so unknown live data reads as "no state known", never
 * as calm and never as an alarm.
 *
 * Precedence, most decision-critical first:
 *   lifecycle (frozen, delisted, quarantined, pre-launch)
 *   > critical  a curated danger notice that is not resolved history
 *   > depeg     an open confirmed depeg incident
 *   > paused    a warning/info notice of kind "paused" (mint, deposit, redemption, transfer…)
 *   > dews      a DEWS band of ALERT or worse
 *   > deadline  the nearest upcoming holder deadline within DEADLINE_HORIZON_DAYS, else the most
 *               recently passed one within DEADLINE_GRACE_DAYS
 * Labels and tones live in `classification/coin-state.ts`.
 *
 * A notice with `chains` applies only on those chains' pages (`chainId`);
 * every other surface resolves asset-wide and skips it.
 */

import type { DdrResolutionTier } from "../types/depeg-resolver";
import type { CoinNotice } from "../types/stablecoin-meta-primitives";
import type { StablecoinStatus } from "../types/stablecoin-taxonomy";
import { isDewsAlertBand } from "./classification/risk";

export const COIN_STATE_KIND_VALUES = [
  "frozen",
  "delisted",
  "quarantined",
  "pre-launch",
  "critical",
  "depeg",
  "paused",
  "dews",
  "deadline",
] as const;
export type CoinStateKind = (typeof COIN_STATE_KIND_VALUES)[number];

/** The curated-notice fields the ladder reads: the client list projection's alert shape. */
export type CoinStateNotice = Pick<CoinNotice, "type" | "title" | "kind" | "deadline" | "asOf" | "chains">;

/**
 * The one notice-staleness authority (ADR-32): a current notice whose `asOf`
 * is more than this many days old is due for re-confirmation. A paused
 * notice reads its own budget before its type's.
 */
export const NOTICE_STALE_DAYS = { paused: 14, danger: 30, warning: 90, info: 180 } as const;

/** A deadline state shows from this many days before the date… */
export const DEADLINE_HORIZON_DAYS = 30;
/** …until this many days after it. */
const DEADLINE_GRACE_DAYS = 30;

const DAY_SEC = 86_400;

export interface CoinStateInputs {
  status?: StablecoinStatus | null;
  notices?: readonly CoinStateNotice[] | null;
  /** peg-summary `activeDepeg`: an open confirmed incident. */
  activeDepeg?: boolean | null;
  deviationBps?: number | null;
  /** The published (frozen) DDR verdict tier, when one exists. */
  ddrTier?: DdrResolutionTier | null;
  /** The forecast's methodology version, so the tier keeps the label it was published with. */
  ddrMethodologyVersion?: string | null;
  /** DEWS band as published by stress-signals. */
  dewsBand?: string | null;
  /** Wall-clock seconds. Only deadline states read it; without it no deadline state is claimed. */
  nowSec?: number | null;
  /** The chain page resolving the states; absent or null resolves asset-wide, skipping chain-scoped notices. */
  chainId?: string | null;
}

export type CoinState = (
  | { kind: "frozen" | "delisted" | "quarantined" | "pre-launch" }
  | { kind: "critical" | "paused"; notice: CoinStateNotice }
  | {
      kind: "depeg";
      deviationBps: number | null;
      ddrTier: DdrResolutionTier | null;
      ddrMethodologyVersion: string | null;
    }
  | { kind: "dews"; band: "ALERT" | "WARNING" | "DANGER" }
  | { kind: "deadline"; notice: CoinStateNotice & { deadline: string }; daysToDeadline: number }
) & {
  /** Symbol of the linked venue whose state a consumer carries onto another coin's row; `resolveCoinStates` never sets it. */
  venue?: string;
};

const LIFECYCLE_KINDS: ReadonlySet<string> = new Set(["frozen", "delisted", "quarantined", "pre-launch"]);

/** Whole UTC days from `nowSec` to an ISO date (0 = today, negative once passed); null when either is unusable. */
export function daysUntilIsoDate(isoDate: string, nowSec: number | null | undefined): number | null {
  if (nowSec == null || !Number.isFinite(nowSec)) return null;
  const deadlineMs = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.round(deadlineMs / 1000 / DAY_SEC) - Math.floor(nowSec / DAY_SEC);
}

/** A notice applies asset-wide unless it names chains, and then only on one of them. */
export function noticeAppliesToScope(notice: Pick<CoinStateNotice, "chains">, chainId?: string | null): boolean {
  return !notice.chains?.length || (chainId != null && notice.chains.includes(chainId));
}

/**
 * A deadline notice is spent once its grace window has passed, or while the
 * clock is unknown. Only `kind: "deadline"` retires: a paused notice that
 * names a closing date stays current until it is edited.
 */
export function isSpentDeadline(notice: Pick<CoinStateNotice, "kind" | "deadline">, nowSec: number | null | undefined): boolean {
  if (notice.kind !== "deadline" || !notice.deadline) return false;
  const days = daysUntilIsoDate(notice.deadline, nowSec);
  return days === null || days < -DEADLINE_GRACE_DAYS;
}

/** Whether a deadline `days` away displaces the current lead: upcoming beats passed, then nearest wins. */
function deadlineLeads(days: number, leadDays: number): boolean {
  if ((days >= 0) !== (leadDays >= 0)) return days >= 0;
  return days >= 0 ? days < leadDays : days > leadDays;
}

/** Every exceptional state that applies, highest precedence first, each kind at most once. */
export function resolveCoinStates(inputs: CoinStateInputs): CoinState[] {
  const states: CoinState[] = [];
  const status = inputs.status;
  if (status && LIFECYCLE_KINDS.has(status)) {
    states.push({ kind: status as "frozen" | "delisted" | "quarantined" | "pre-launch" });
  }

  // A deadline notice whose grace window has ended is spent: it reads as history, never an alarm.
  // Without the clock its window is unknown, so it claims nothing (deadline states need the clock too).
  const current = (inputs.notices ?? []).filter((notice) =>
    notice.kind !== "history" && !isSpentDeadline(notice, inputs.nowSec) && noticeAppliesToScope(notice, inputs.chainId));
  const critical = current.find((notice) => notice.type === "danger");
  if (critical) states.push({ kind: "critical", notice: critical });

  if (inputs.activeDepeg === true) {
    states.push({
      kind: "depeg",
      deviationBps: Number.isFinite(inputs.deviationBps) ? (inputs.deviationBps as number) : null,
      ddrTier: inputs.ddrTier ?? null,
      ddrMethodologyVersion: inputs.ddrMethodologyVersion ?? null,
    });
  }

  const paused = current.find((notice) => notice.kind === "paused" && notice.type !== "danger");
  if (paused) states.push({ kind: "paused", notice: paused });

  if (typeof inputs.dewsBand === "string" && isDewsAlertBand(inputs.dewsBand)) {
    states.push({ kind: "dews", band: inputs.dewsBand });
  }

  // The nearest upcoming date in the window leads over any passed one; when every
  // date has passed, the most recently passed leads. Equal dates keep authored order.
  let lead: { notice: CoinStateNotice & { deadline: string }; days: number } | null = null;
  for (const notice of current) {
    if (notice.kind !== "deadline" || !notice.deadline) continue;
    const days = daysUntilIsoDate(notice.deadline, inputs.nowSec);
    if (days === null || days > DEADLINE_HORIZON_DAYS || days < -DEADLINE_GRACE_DAYS) continue;
    if (lead === null || deadlineLeads(days, lead.days)) lead = { notice: { ...notice, deadline: notice.deadline }, days };
  }
  if (lead) states.push({ kind: "deadline", notice: lead.notice, daysToDeadline: lead.days });
  return states;
}

/** The single state a compact chip shows: the highest-precedence one, or null. */
export function resolveCoinState(inputs: CoinStateInputs): CoinState | null {
  return resolveCoinStates(inputs)[0] ?? null;
}
