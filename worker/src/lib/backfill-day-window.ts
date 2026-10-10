import { errorResponse } from "./api-response";
import { parseDayStartParam } from "./api-params";
import { DAY_SECONDS } from "@shared/lib/time-constants";

const BACKFILL_REPLAY_CONTEXT_DAYS = 7;
export const MAX_BACKFILL_REPLAY_CONTEXT_DAYS = 90;

export interface BackfillReplayWindow {
  contextDays: number;
  startDay: number | null;
  endDay: number | null;
  compareStartSec: number | null;
  compareEndSec: number | null;
  replayStartSec: number | null;
  replayEndSec: number | null;
}

function parseContextDaysParam(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_BACKFILL_REPLAY_CONTEXT_DAYS) return null;
  return parsed;
}

export interface OptionalDayWindow {
  startDay: number | null;
  endDay: number | null;
  hasExplicitWindow: boolean;
  usedDefaultWindow: boolean;
  contextDays: number | null;
  replayWindow: BackfillReplayWindow | null;
}

export interface OptionalDayWindowOptions {
  defaultStartDay?: number | null;
  defaultEndDay?: number | null;
  minStartDay?: number | null;
  maxEndDay?: number | null;
  rejectInvertedRange?: boolean;
  includeContextDays?: boolean;
  defaultContextDays?: number;
  includeReplayWindow?: boolean;
  invalidDayMessage?: string;
  invalidStartDayMessage?: string;
  invalidEndDayMessage?: string;
  invalidRangeMessage?: string;
}

export function parseOptionalDayWindow(
  url: URL,
  options: OptionalDayWindowOptions = {},
): OptionalDayWindow | Response {
  const startDayRaw = url.searchParams.get("startDay");
  const endDayRaw = url.searchParams.get("endDay");
  const parsedStartDay = parseDayStartParam(startDayRaw);
  const parsedEndDay = parseDayStartParam(endDayRaw);
  const invalidDayMessage =
    options.invalidDayMessage ??
    "Invalid startDay/endDay. Use Unix seconds/milliseconds or YYYY-MM-DD.";

  if (startDayRaw && parsedStartDay == null) {
    return errorResponse(400, options.invalidStartDayMessage ?? invalidDayMessage);
  }
  if (endDayRaw && parsedEndDay == null) {
    return errorResponse(400, options.invalidEndDayMessage ?? invalidDayMessage);
  }

  let contextDays: number | null = null;
  if (options.includeContextDays) {
    const contextRaw = url.searchParams.get("contextDays");
    const parsedContextDays = parseContextDaysParam(contextRaw);
    if (contextRaw && parsedContextDays == null) {
      return errorResponse(
        400,
        `Invalid contextDays. Use an integer between 0 and ${MAX_BACKFILL_REPLAY_CONTEXT_DAYS}.`,
      );
    }
    contextDays = parsedContextDays ?? options.defaultContextDays ?? BACKFILL_REPLAY_CONTEXT_DAYS;
  }

  const hasExplicitWindow = url.searchParams.has("startDay") || url.searchParams.has("endDay");
  const usedDefaultWindow = parsedStartDay == null && parsedEndDay == null;
  let startDay = parsedStartDay ?? options.defaultStartDay ?? null;
  let endDay = parsedEndDay ?? options.defaultEndDay ?? null;

  if (startDay != null && options.minStartDay != null) {
    startDay = Math.max(options.minStartDay, startDay);
  }
  if (endDay != null && options.maxEndDay != null) {
    endDay = Math.min(options.maxEndDay, endDay);
  }

  if (
    (options.rejectInvertedRange ?? true) &&
    startDay != null &&
    endDay != null &&
    startDay > endDay
  ) {
    return errorResponse(
      400,
      options.invalidRangeMessage ?? "Invalid startDay/endDay: startDay must be <= endDay.",
    );
  }

  const replayWindow = options.includeReplayWindow && hasExplicitWindow
    ? buildReplayWindow(startDay, endDay, contextDays ?? options.defaultContextDays ?? BACKFILL_REPLAY_CONTEXT_DAYS)
    : null;

  return {
    startDay,
    endDay,
    hasExplicitWindow,
    usedDefaultWindow,
    contextDays,
    replayWindow,
  };
}

export function buildReplayWindow(
  startDay: number | null,
  endDay: number | null,
  contextDays = BACKFILL_REPLAY_CONTEXT_DAYS,
): BackfillReplayWindow {
  const compareStartSec = startDay;
  const compareEndSec = endDay != null ? endDay + DAY_SECONDS - 1 : null;
  return {
    contextDays,
    startDay,
    endDay,
    compareStartSec,
    compareEndSec,
    replayStartSec:
      compareStartSec != null
        ? Math.max(0, compareStartSec - contextDays * DAY_SECONDS)
        : null,
    replayEndSec:
      compareEndSec != null
        ? compareEndSec + contextDays * DAY_SECONDS
        : null,
  };
}
