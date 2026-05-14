import {
  adminErrorResponse,
  adminJsonResponse,
  type AdminUrlRouteContext,
  makeConditionalIdempotentAdminRoute,
} from "../lib/route-wrappers";
import { logAdminAction } from "../lib/admin-action-audit";
import {
  clearPendingAlertsForAdmin,
  countPendingAlertsForAdmin,
} from "../cron/telegram-pending-queue";

function parseOlderThanSec(raw: string | null): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function parseDryRun(raw: string | null): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isDryRunRequest(url: URL): boolean {
  return parseDryRun(
    url.searchParams.get("dry_run")
      ?? url.searchParams.get("dryRun")
      ?? url.searchParams.get("dry-run"),
  );
}

export const handleClearTelegramPending = makeConditionalIdempotentAdminRoute<AdminUrlRouteContext>(
  "route-clear-telegram-pending",
  "clear-telegram-pending",
  ({ url }) => !isDryRunRequest(url),
  async ({ db, url, request }) => {
    const chatId = url.searchParams.get("chat_id")?.trim() || null;
    const olderThanSec = parseOlderThanSec(url.searchParams.get("older_than_sec"));
    const dryRun = isDryRunRequest(url);

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
    const filter = chatId
      ? { chatId }
      : { olderThanCutoffSec: nowSec - olderThanSec! };

    if (dryRun) {
      const matched = await countPendingAlertsForAdmin(db, filter);
      await logAdminAction(
        db,
        {
          action: "clear-telegram-pending",
          target: chatId ?? `older_than_sec=${olderThanSec}`,
          result: "ok",
          httpStatus: 200,
          details: { chatId, olderThanSec, dryRun: true, matched },
        },
        request,
      );
      return adminJsonResponse({ ok: true, dryRun: true, matched }, { status: 200 });
    }

    let deleted = 0;
    deleted = await clearPendingAlertsForAdmin(db, filter, nowSec);

    await logAdminAction(
      db,
      {
        action: "clear-telegram-pending",
        target: chatId ?? `older_than_sec=${olderThanSec}`,
        result: "ok",
        httpStatus: 200,
        details: { chatId, olderThanSec, dryRun: false, deleted },
      },
      request,
    );
    return adminJsonResponse({ ok: true, deleted }, { status: 200 });
  },
);
