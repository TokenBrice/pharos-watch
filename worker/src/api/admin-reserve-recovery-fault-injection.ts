import { SYNC_ORDERED_CONFIGURED_COINS } from "../cron/sync-live-reserves-shared";
import { adminErrorResponse, adminJsonResponse } from "../lib/route-wrappers";
import { isWorkerPreviewRequest, requireAdmin } from "../lib/auth";
import {
  armReserveRecoveryFaultInjection,
  RESERVE_RECOVERY_FAULT_KILL_POINTS,
  type ReserveRecoveryFaultKillPoint,
} from "../lib/reserve-recovery-fault-injection";

const ITEM_KILL_POINTS = new Set<ReserveRecoveryFaultKillPoint>([
  "after_pending_begin",
  "after_authoritative_write",
]);
const CONFIGURED_COIN_IDS = new Set(SYNC_ORDERED_CONFIGURED_COINS.map((coin) => coin.id));

function isFourHourlyReserveSlot(timestamp: number): boolean {
  const date = new Date(timestamp * 1000);
  return date.getUTCMinutes() === 11 && date.getUTCHours() % 4 === 0 && date.getUTCSeconds() === 0;
}

export async function handleArmReserveRecoveryFaultInjection(
  db: D1Database,
  request: Request,
  trustedAdmin: boolean,
  currentWorkerVersion: string | null,
): Promise<Response> {
  const authError = await requireAdmin(request, trustedAdmin);
  if (authError) return authError;
  if (!isWorkerPreviewRequest(request)) {
    return adminErrorResponse(403, "Reserve recovery fault injection is available only on workers.dev preview hosts.");
  }
  if (!currentWorkerVersion) {
    return adminErrorResponse(503, "Worker version metadata is unavailable.");
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json<Record<string, unknown>>();
  } catch {
    return adminErrorResponse(400, "Request body must be valid JSON.");
  }

  const workerVersion = typeof body.workerVersion === "string" ? body.workerVersion.trim() : "";
  const scheduleKey = body.scheduleKey;
  const slotStartedAt = body.slotStartedAt;
  const attemptNo = body.attemptNo;
  const killPoint = body.killPoint;
  const targetItemKey = typeof body.targetItemKey === "string" ? body.targetItemKey.trim() : null;
  if (workerVersion !== currentWorkerVersion) {
    return adminErrorResponse(409, "workerVersion must exactly match the executing preview Worker version.");
  }
  if (scheduleKey !== "fourHourlyReserveSync") {
    return adminErrorResponse(400, "scheduleKey must be fourHourlyReserveSync.");
  }
  if (!Number.isInteger(slotStartedAt) || !isFourHourlyReserveSlot(slotStartedAt as number)) {
    return adminErrorResponse(400, "slotStartedAt must be an exact fourHourlyReserveSync UTC slot.");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if ((slotStartedAt as number) < nowSec - 5 * 60 || (slotStartedAt as number) > nowSec + 6 * 60 * 60) {
    return adminErrorResponse(400, "slotStartedAt must be within five minutes in the past or six hours in the future.");
  }
  if (!Number.isInteger(attemptNo) || (attemptNo as number) < 1 || (attemptNo as number) > 20) {
    return adminErrorResponse(400, "attemptNo must be an integer from 1 through 20.");
  }
  if (!RESERVE_RECOVERY_FAULT_KILL_POINTS.includes(killPoint as ReserveRecoveryFaultKillPoint)) {
    return adminErrorResponse(400, "Unknown reserve recovery fault killPoint.");
  }
  if (ITEM_KILL_POINTS.has(killPoint as ReserveRecoveryFaultKillPoint)) {
    if (!targetItemKey || !CONFIGURED_COIN_IDS.has(targetItemKey)) {
      return adminErrorResponse(400, "targetItemKey must name a configured reserve asset for this killPoint.");
    }
  } else if (targetItemKey) {
    return adminErrorResponse(400, "targetItemKey is accepted only for per-asset kill points.");
  }

  const result = await armReserveRecoveryFaultInjection(db, {
    workerVersion,
    scheduleKey,
    slotStartedAt: slotStartedAt as number,
    attemptNo: attemptNo as number,
    killPoint: killPoint as ReserveRecoveryFaultKillPoint,
    targetItemKey,
    nowSec,
  });
  if (!result.armed) {
    return adminErrorResponse(409, "A one-shot fault is already armed for this exact scheduled attempt.");
  }
  return adminJsonResponse({ ok: true, armed: true, fault: result.spec }, { status: 201 });
}
