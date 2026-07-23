// Lead-governance policy for the daily digest's critical-depeg override.
//
// The July 2026 "USX era" (17 consecutive forced leads on a $20M coin) came
// from an ageless hard requirement: any critical depeg re-won the mandatory
// lead every day until its event closed. These rules keep day-0/day-1 crisis
// coverage intact while demoting unchanged ongoing stories to a one-line
// standing mention. Constants owner-ratified 2026-07-18.

/** An event this recent counts as breaking news and may hard-lead. */
const NEWLY_CRITICAL_WINDOW_H = 48;

/** A day-over-day worsening this large re-qualifies an old event for a hard lead. */
const RE_ESCALATION_BPS = 500;

/** One event may hard-lead at most this many consecutive editions... */
export const MAX_CONSECUTIVE_HARD_LEADS = 2;

/** ...and at most this many editions within the trailing quota window. */
const MAX_LEADS_PER_WINDOW = 3;

/** Number of trailing editions the lead quota is evaluated over. */
const LEAD_QUOTA_WINDOW = 7;

export interface LeadStreakSummary {
  /** Consecutive editions (newest backwards) this candidate led. */
  consecutive: number;
  /** Editions this candidate led within the trailing quota window. */
  inWindow: number;
}

/**
 * Compute how often a candidate has led recently.
 * `recentLeadSignalIds` is ordered newest-first (today's edition excluded).
 */
export function computeLeadStreak(
  recentLeadSignalIds: readonly (string | null | undefined)[],
  candidateId: string,
): LeadStreakSummary {
  let consecutive = 0;
  for (const leadId of recentLeadSignalIds) {
    if (leadId !== candidateId) break;
    consecutive += 1;
  }
  const inWindow = recentLeadSignalIds
    .slice(0, LEAD_QUOTA_WINDOW)
    .filter((leadId) => leadId === candidateId).length;
  return { consecutive, inWindow };
}

export type CriticalLeadDecision =
  | { severity: "hard"; reason: string }
  | { severity: "soft"; reason: string };

/**
 * Decide whether today's top critical depeg is a hard lead requirement or a
 * demoted standing mention.
 *
 * - A material worsening always re-qualifies, quota or not: a story that
 *   genuinely moved is news again.
 * - A newly-broken event hard-leads until the quota is exhausted.
 * - Everything else is a soft mention-only requirement: the coin must still
 *   appear (readers tracking it must not lose it), but it cannot monopolize
 *   the headline.
 */
export function decideCriticalLeadSeverity(params: {
  symbol: string;
  ageHours: number | undefined;
  severityBps: number;
  previousSeverityBps: number | null;
  streak: LeadStreakSummary;
}): CriticalLeadDecision {
  const { symbol, ageHours, severityBps, previousSeverityBps, streak } = params;
  const worsened =
    previousSeverityBps != null && Math.abs(severityBps) - Math.abs(previousSeverityBps) >= RE_ESCALATION_BPS;
  if (worsened) {
    return {
      severity: "hard",
      reason: `${symbol} critical depeg worsened ${Math.abs(severityBps) - Math.abs(previousSeverityBps ?? 0)} bps since the previous edition`,
    };
  }
  const quotaExhausted =
    streak.consecutive >= MAX_CONSECUTIVE_HARD_LEADS || streak.inWindow >= MAX_LEADS_PER_WINDOW;
  const newlyCritical = ageHours != null && ageHours <= NEWLY_CRITICAL_WINDOW_H;
  if (newlyCritical && !quotaExhausted) {
    return {
      severity: "hard",
      reason: `${symbol} active depeg crossed the critical severity threshold within the last ${NEWLY_CRITICAL_WINDOW_H}h`,
    };
  }
  if (newlyCritical) {
    return {
      severity: "soft",
      reason: `${symbol} remains critically depegged but has led ${streak.consecutive} consecutive editions (${streak.inWindow} in the last ${LEAD_QUOTA_WINDOW}); cover in at most one sentence unless it moves`,
    };
  }
  return {
    severity: "soft",
    reason: `${symbol} is an ongoing critical depeg with no material change since the previous edition; cover in at most one sentence, do not lead with it`,
  };
}
