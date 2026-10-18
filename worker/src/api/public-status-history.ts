import { parseEnumParam, parseQueryParams } from "../lib/api-params";
import { errorResponse, jsonResponse } from "../lib/api-response";
import { listRecentStatusTransitions } from "../lib/status-reliability";
import { API_CACHE_PROFILES as CACHE_PROFILES } from "@shared/lib/api-cache-profiles";
import { assessPublicHealth, buildPublicHealthResponse } from "../lib/public-health-assessment";
import { headlineToStatusLevel, projectPublicStatus } from "@shared/lib/public-status-components";
import { listPublicStatusTransitions } from "../lib/status/public-status-state";
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
    source: "legacy",
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
  transitions: PublicStatusTransition[],
  currentStatus: PublicStatusHistoryResponse["currentStatus"],
  headlineLevel: PublicStatusHistoryResponse["currentStatus"],
): number | null {
  const latest = transitions.reduce<PublicStatusTransition | null>((candidate, transition) => {
    if (!candidate || transition.at > candidate.at) return transition;
    if (transition.at === candidate.at && transition.id > candidate.id) return transition;
    return candidate;
  }, null);
  if (!latest) return null;
  return latest.to === (latest.source === "public" ? headlineLevel : currentStatus) ? latest.at : null;
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
    let transitionQueryFailed = false;

    // Public-projection rows and the live assessment load together; legacy
    // operator rows are read only for time before the first public row, so a
    // growing post-cutover operator log can never crowd them out of the page.
    const [publicHistory, publicHealth] = await Promise.all([
      listPublicStatusTransitions(db, parsed.limit, from).catch(() => {
        transitionQueryFailed = true;
        return { transitions: [] as PublicStatusTransition[], startedAt: null, componentHistoryStartedAt: {}, hasMore: false };
      }),
      assessPublicHealth(db, now, { logPrefix: "public-status-history" }),
    ]);
    const startedAt = publicHistory.startedAt;
    const legacyTransitions = startedAt != null && startedAt <= from
      ? []
      : await listRecentStatusTransitions(db, parsed.limit, { from, to: startedAt == null ? null : startedAt - 1 }, () => {
        transitionQueryFailed = true;
      });

    if (transitionQueryFailed) {
      return errorResponse(503, "Public status history unavailable", { noStore: true });
    }

    const legacy = filterPublicStatusTransitions(legacyTransitions)
      .filter((transition) => startedAt == null || transition.at < startedAt)
      .map(toPublicTransition);
    const merged = [...publicHistory.transitions, ...legacy].sort((a, b) => b.at - a.at || b.id - a.id);
    const transitions = merged.slice(0, parsed.limit);

    // Public currentStatus comes from assessPublicHealth — NOT from the
    // state machine's hysteresis-smoothed admin status. This keeps the
    // public hero (/api/health) and this endpoint in sync. The admin
    // /status/ page continues to use /api/status for its smoothed view.
    const publicCurrentStatus = publicHealth.overallStatus;
    // Public rows store the headline's level, so compare like with like.
    const headlineLevel = headlineToStatusLevel(
      projectPublicStatus(buildPublicHealthResponse(publicHealth, now)).headline.state,
    );

    const body: PublicStatusHistoryResponse = {
      timestamp: now,
      currentStatus: publicCurrentStatus,
      lastChangedAt: getPublicLastChangedAt(transitions, publicCurrentStatus, headlineLevel),
      transitions,
      publicHistoryStartedAt: startedAt,
      componentHistoryStartedAt: publicHistory.componentHistoryStartedAt,
      // R7: a bounded page says so instead of passing for the whole window.
      hasMore: publicHistory.hasMore || legacyTransitions.length >= parsed.limit || merged.length > parsed.limit,
    };

    return jsonResponse(body, { headers: { "Cache-Control": CACHE_PROFILES.publicStatus } });
  };
