import { D1_MAX_BOUND_PARAMETERS, executeAtomicBatch } from "../../lib/db";
import { buildUpsertPendingDepegStmt } from "../../lib/depeg-pending";
import type { DepegPersistenceCommand } from "./types";

function buildDepegPersistenceStatement(
  db: D1Database,
  command: DepegPersistenceCommand,
): D1PreparedStatement {
  switch (command.type) {
    case "upsert-pending":
      return buildUpsertPendingDepegStmt(db, command.payload);
    case "close-event":
      return db
        .prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = ?, close_reason = ?, recovery_first_seen_at = NULL, recovery_last_seen_at = NULL WHERE id = ?")
        .bind(command.endedAt, command.recoveryPrice, command.closeReason, command.id);
    case "update-peak":
      return db
        .prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?")
        .bind(command.peakDeviationBps, command.peakPrice, command.id);
    case "begin-recovery":
      return db
        .prepare("UPDATE depeg_events SET recovery_first_seen_at = ?, recovery_last_seen_at = ? WHERE id = ?")
        .bind(command.firstSeenAt, command.lastSeenAt, command.id);
    case "continue-recovery":
      return db
        .prepare("UPDATE depeg_events SET recovery_last_seen_at = ? WHERE id = ?")
        .bind(command.lastSeenAt, command.id);
    case "clear-recovery":
      return db
        .prepare("UPDATE depeg_events SET recovery_first_seen_at = NULL, recovery_last_seen_at = NULL WHERE id = ? AND (recovery_first_seen_at IS NOT NULL OR recovery_last_seen_at IS NOT NULL)")
        .bind(command.id);
    case "delete-event":
      return db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(command.id);
  }
}

async function loadEventAssetIds(
  db: D1Database,
  commands: DepegPersistenceCommand[],
): Promise<Map<number, string>> {
  const eventIds = [...new Set(commands.flatMap((command) =>
    command.type === "upsert-pending" ? [] : [command.id]
  ))];
  if (eventIds.length === 0) return new Map();

  const eventAssetIds = new Map<number, string>();
  for (let offset = 0; offset < eventIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const eventIdChunk = eventIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const placeholders = eventIdChunk.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT id, stablecoin_id FROM depeg_events WHERE id IN (${placeholders})`)
      .bind(...eventIdChunk)
      .all<{ id: number; stablecoin_id: string }>();
    for (const row of result.results ?? []) eventAssetIds.set(row.id, row.stablecoin_id);
  }
  return eventAssetIds;
}

export async function persistDepegCommands(
  db: D1Database,
  commands: DepegPersistenceCommand[],
): Promise<number> {
  if (commands.length === 0) return 0;
  const eventAssetIds = await loadEventAssetIds(db, commands);
  const groups = new Map<string, D1PreparedStatement[]>();

  for (const command of commands) {
    const assetId = command.type === "upsert-pending"
      ? command.payload.stablecoinId
      : eventAssetIds.get(command.id) ?? `event:${command.id}`;
    const group = groups.get(assetId) ?? [];
    group.push(buildDepegPersistenceStatement(db, command));
    groups.set(assetId, group);
  }

  for (const statements of groups.values()) {
    await executeAtomicBatch(db, statements);
  }
  return commands.length;
}
