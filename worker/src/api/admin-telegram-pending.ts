import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
  makeIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { logAdminAction } from "../lib/admin-action-audit";
import { clearPendingAlertsForAdmin } from "../cron/telegram-pending-queue";

function parseOlderThanSec(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export const handleClearTelegramPending = makeIdempotentAdminRoute<AdminUrlRouteContext>(
  "route-clear-telegram-pending",
  "clear-telegram-pending",
  async ({ db, url, request }) => {
    const chatId = url.searchParams.get("chat_id")?.trim() || null;
    const olderThanSec = parseOlderThanSec(url.searchParams.get("older_than_sec"));

    if (!chatId && olderThanSec == null) {
      return adminErrorResponse(
        400,
        "Missing required filter: pass either ?chat_id=<id> or ?older_than_sec=<positive-integer>",
      );
    }
    if (chatId && olderThanSec != null) {
      return adminErrorResponse(
        400,
        "Pass only one of ?chat_id or ?older_than_sec, not both",
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    let deleted = 0;
    if (chatId) {
      deleted = await clearPendingAlertsForAdmin(db, { chatId }, nowSec);
    } else if (olderThanSec != null) {
      deleted = await clearPendingAlertsForAdmin(db, { olderThanCutoffSec: nowSec - olderThanSec }, nowSec);
    }

    await logAdminAction(
      db,
      {
        action: "clear-telegram-pending",
        target: chatId ?? `older_than_sec=${olderThanSec}`,
        result: "ok",
        httpStatus: 200,
        details: { chatId, olderThanSec, deleted },
      },
      request,
    );
    return adminJsonResponse({ ok: true, deleted }, { status: 200 });
  },
);
