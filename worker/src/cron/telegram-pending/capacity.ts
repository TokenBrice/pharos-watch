import {
  loadTelegramPendingCapacity,
  estimateTelegramDrainTimeSec,
  TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT,
} from "../../lib/telegram-pending-capacity";
import { logTelegramEvent } from "../../lib/telegram-log";
import type { PendingCapacityReadResult, PendingCapacitySnapshot } from "./types";

export {
  estimateTelegramDrainTimeSec,
  TELEGRAM_EXECUTION_UNKNOWN_SAMPLE_LIMIT as EXECUTION_UNKNOWN_SAMPLE_LIMIT,
};

export async function readPendingCapacity(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun?: number,
): Promise<PendingCapacityReadResult> {
  try {
    return {
      status: "available",
      value: await loadTelegramPendingCapacity(db, nowSec, drainBudgetPerRun),
    };
  } catch {
    logTelegramEvent({
      level: "warn",
      message: "Failed to read pending capacity snapshot",
      action: "read-pending-capacity",
      module: "telegram-pending-capacity",
      errorClass: "d1",
    });
    return { status: "unknown", errorClass: "query_failed" };
  }
}

export async function readPendingCapacitySnapshot(
  db: D1Database,
  nowSec: number,
  drainBudgetPerRun?: number,
): Promise<PendingCapacitySnapshot> {
  const result = await readPendingCapacity(db, nowSec, drainBudgetPerRun);
  if (result.status === "unknown") {
    throw new Error(`Pending capacity unavailable: ${result.errorClass}`);
  }
  return result.value;
}
