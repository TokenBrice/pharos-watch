import { errorResponse, jsonResponse } from "../lib/api-response";
import { parseClampedIntegerParam } from "../lib/api-params";
import { makeAdminRoute, type AdminUrlRouteContext } from "../lib/route-wrappers";
import { loadReserveSyncAttemptTimeline } from "../lib/live-reserves/store-history-read";

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

export const handleReserveAttemptHistoryRoute = makeAdminRoute<AdminUrlRouteContext>(
  "reserve-attempt-history",
  async ({ db, url }) => {
    const coin = url.searchParams.get("coin");
    if (!coin) {
      return errorResponse(400, "Missing required 'coin' query parameter.");
    }
    const limit = parseClampedIntegerParam(url.searchParams.get("limit"), DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT);
    const attempts = await loadReserveSyncAttemptTimeline(db, coin, limit);
    return jsonResponse({ coin, attempts }, { noStore: true });
  },
);
