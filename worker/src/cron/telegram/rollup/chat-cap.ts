import { TELEGRAM_ALERT_POLICY } from "@shared/lib/telegram-delivery-policy";
import { buildInClause, chunkArray } from "../../../lib/db";
import type { TelegramDeliveryInput } from "../../../telegram/delivery/jobs";
import { buildTelegramChangeLogStatements, type TelegramChangeLogEntry } from "./change-log";

const CAP = TELEGRAM_ALERT_POLICY.chatCap;

/** Live message kinds that count against the per-chat cap. Roll-ups and hourly batches do not. */
const CAPPED_JOB_KINDS = ["alert", "freeze"] as const;

/** Rows that are, or may have been, delivered. Duplicates, expiries and failures do not count. */
const COUNTED_STATES = ["pending", "retry", "sending", "sent", "unknown"] as const;

function isDepegExempt(delivery: TelegramDeliveryInput): boolean {
  return (delivery.families ?? []).includes("depeg");
}

/** Live non-depeg messages per chat in the rolling cap window (one per job, whatever its chunk count). */
async function countCappedMessages(
  db: D1Database,
  chatIds: readonly string[],
  nowSec: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const fixedBinds = 1 + CAPPED_JOB_KINDS.length + COUNTED_STATES.length;
  for (const chunk of chunkArray([...new Set(chatIds)], 100 - fixedBinds)) {
    const chats = buildInClause(chunk);
    const kinds = buildInClause([...CAPPED_JOB_KINDS]);
    const states = buildInClause([...COUNTED_STATES]);
    const rows = await db.prepare(
      `SELECT chat_id, COUNT(DISTINCT job_id) AS messages
         FROM telegram_deliveries
        WHERE chat_id IN (${chats.sql})
          AND created_at > ?
          AND kind IN (${kinds.sql})
          AND state IN (${states.sql})
          AND (families IS NULL OR (',' || families || ',') NOT LIKE '%,depeg,%')
        GROUP BY chat_id`,
    ).bind(...chats.binds, nowSec - CAP.windowSec, ...kinds.binds, ...states.binds)
      .all<{ chat_id: string; messages: number }>();
    for (const row of rows.results ?? []) counts.set(row.chat_id, Number(row.messages));
  }
  return counts;
}

/**
 * Per-chat cap, enforced when a live job is planned: at most
 * `chatCap.maxRealtimeMessages` non-depeg live messages per chat per rolling
 * window. A chat over the cap gets no rows for this job; instead an overflow
 * entry is written so its next daily roll-up says how many alerts were held
 * back. Put `overflowStatements` in the same D1 batch as the admitted rows.
 */
export async function applyTelegramChatCap(
  db: D1Database,
  input: { jobId: string; nowSec: number; deliveries: readonly TelegramDeliveryInput[] },
): Promise<{ admitted: TelegramDeliveryInput[]; overflow: TelegramChangeLogEntry[]; overflowStatements: D1PreparedStatement[] }> {
  const cappedChatIds = input.deliveries.filter((delivery) => !isDepegExempt(delivery)).map((delivery) => delivery.chatId);
  const counts = cappedChatIds.length > 0 ? await countCappedMessages(db, cappedChatIds, input.nowSec) : new Map<string, number>();
  const admitted: TelegramDeliveryInput[] = [];
  const overflowByChat = new Map<string, { families: Set<string>; coinIds: Set<string> }>();
  for (const delivery of input.deliveries) {
    if (isDepegExempt(delivery) || (counts.get(delivery.chatId) ?? 0) < CAP.maxRealtimeMessages) {
      admitted.push(delivery);
      continue;
    }
    const overflow = overflowByChat.get(delivery.chatId) ?? { families: new Set<string>(), coinIds: new Set<string>() };
    for (const family of delivery.families ?? []) overflow.families.add(family);
    for (const coinId of delivery.coinIds ?? []) overflow.coinIds.add(coinId);
    overflowByChat.set(delivery.chatId, overflow);
  }
  const overflow: TelegramChangeLogEntry[] = [...overflowByChat].map(([chatId, held]) => ({
    kind: "overflow",
    chatId,
    sourceKey: `overflow:${input.jobId}:${chatId}`,
    observedAt: input.nowSec,
    payload: { families: [...held.families], coinIds: [...held.coinIds] },
  }));
  return { admitted, overflow, overflowStatements: buildTelegramChangeLogStatements(db, overflow) };
}
