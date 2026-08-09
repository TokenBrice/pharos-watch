import { parseEnumParam, parseQueryParams, jsonResponse } from "../lib/api-utils";
import { listRecentStatusTransitions } from "../lib/status-reliability";
import { CACHE_PROFILES } from "../lib/constants";
import { assessPublicHealth } from "../lib/public-health-assessment";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import {
  PUBLIC_STATUS_HISTORY_WINDOWS,
  type PublicStatusHistoryResponse,
  type PublicStatusHistoryWindow,
  type PublicStatusTransition,
  type StatusTransition,
} from "@shared/types/status";

const MAX_LIMIT = 200;
const DEFAULT_WINDOW: PublicStatusHistoryWindow = "30d";
const WINDOW_TO_SECONDS: Record<PublicStatusHistoryWindow, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};
const VALID_WINDOWS = new Set<PublicStatusHistoryWindow>(PUBLIC_STATUS_HISTORY_WINDOWS);

function toPublicTransition(t: StatusTransition): PublicStatusTransition {
  return {
    id: t.id,
    from: t.from,
    to: t.to,
    transitionType: t.transitionType,
    reason: t.reason,
    at: t.at,
  };
}

function filterPublicStatusTransitions(transitions: StatusTransition[]): StatusTransition[] {
  const chronological = [...transitions].sort((a, b) => a.at - b.at || a.id - b.id);
  const includedIds = new Set<number>();
  let publicIncidentActive = false;

  for (const transition of chronological) {
    const hasPublicImpact = transitionHasPublicImpact(transition.causes);
    if (!hasPublicImpact && !publicIncidentActive) continue;

    includedIds.add(transition.id);
    publicIncidentActive = transition.to !== "healthy";
  }

  return transitions.filter((transition) => includedIds.has(transition.id));
}

function getPublicLastChangedAt(
  transitions: StatusTransition[],
  currentStatus: PublicStatusHistoryResponse["currentStatus"],
): number | null {
  const latest = transitions.reduce<StatusTransition | null>((candidate, transition) => {
    if (!candidate || transition.at > candidate.at) return transition;
    if (transition.at === candidate.at && transition.id > candidate.id) return transition;
    return candidate;
  }, null);
  return latest?.to === currentStatus ? latest.at : null;
}

export const handlePublicStatusHistory = async (db: D1Database, request: Request): Promise<Response> => {
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request.url);
    const parsed = parseQueryParams(url.searchParams, {
      limit: { type: "int", default: 50, min: 1, max: MAX_LIMIT, rangePolicy: "reject" },
    });
    if (parsed instanceof Response) return parsed;
    const window = parseEnumParam(url.searchParams.get("window"), VALID_WINDOWS, "window", DEFAULT_WINDOW);
    if (window instanceof Response) return window;

    const from = now - WINDOW_TO_SECONDS[window];

    // Two parallel loads:
    //   1. the full transition list in the window (will be filtered below)
    //   2. the public health assessment — same function /api/health uses,
    //      so the hero badge and this endpoint stay in sync
    const [allTransitions, publicHealth] = await Promise.all([
      listRecentStatusTransitions(db, parsed.limit, { from }),
      assessPublicHealth(db, now, { logPrefix: "public-status-history" }),
    ]);

    // Filter transitions to public-impact incidents, while preserving the
    // recovery rows needed to keep the returned state-machine stream coherent.
    // Recovery rows can be info-only after the public-impacting cause clears.
    const filteredTransitions = filterPublicStatusTransitions(allTransitions);

    // Public currentStatus comes from assessPublicHealth — NOT from the
    // state machine's hysteresis-smoothed admin status. This keeps the
    // public hero (/api/health) and this endpoint in sync. The admin
    // /status/ page continues to use /api/status for its smoothed view.
    const publicCurrentStatus = publicHealth.overallStatus;

    const body: PublicStatusHistoryResponse = {
      timestamp: now,
      currentStatus: publicCurrentStatus,
      lastChangedAt: getPublicLastChangedAt(filteredTransitions, publicCurrentStatus),
      transitions: filteredTransitions.map(toPublicTransition),
    };

    return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.publicStatus } });
  };
