// Zod-free wire vocabulary and ordering for tape events. Schemas live in
// `tape-event.ts`; presentation lives in `../lib/classification/tape.ts`.

/** A retracted freeze claim has no public event representation. */
export const FREEZE_CLAIM_RETRACTED_REASON = "freeze-claim-retracted";

export const TAPE_EVENT_SEVERITY_VALUES = [
  "info",
  "notice",
  "warning",
  "severe",
  "critical",
] as const;

export type TapeEventSeverity = (typeof TAPE_EVENT_SEVERITY_VALUES)[number];

export const SEVERITY_RANK: Record<TapeEventSeverity, number> = {
  info: 0,
  notice: 1,
  warning: 2,
  severe: 3,
  critical: 4,
};

export const TAPE_EVENT_TRANSITION_VALUES = [
  "opened",
  "updated",
  "resolved",
  "snapshot",
] as const;

export type TapeEventTransition = (typeof TAPE_EVENT_TRANSITION_VALUES)[number];
