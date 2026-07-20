import { batchExecute } from "../../lib/db";
import { buildUpsertPendingDepegStmt } from "../../lib/depeg-pending";
import type { DepegPersistenceCommand } from "./types";

function buildDepegPersistenceStatements(
  db: D1Database,
  commands: DepegPersistenceCommand[],
): D1PreparedStatement[] {
  return commands.map((command) => {
    switch (command.type) {
      case "upsert-pending":
        return buildUpsertPendingDepegStmt(db, command.payload);
      case "close-event":
        return db
          .prepare("UPDATE depeg_events SET ended_at = ?, recovery_price = ?, close_reason = ?, recovery_first_seen_at = NULL WHERE id = ?")
          .bind(command.endedAt, command.recoveryPrice, command.closeReason, command.id);
      case "update-peak":
        return db
          .prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?")
          .bind(command.peakDeviationBps, command.peakPrice, command.id);
      case "begin-recovery":
        return db
          .prepare("UPDATE depeg_events SET recovery_first_seen_at = ? WHERE id = ? AND recovery_first_seen_at IS NULL")
          .bind(command.firstSeenAt, command.id);
      case "clear-recovery":
        return db
          .prepare("UPDATE depeg_events SET recovery_first_seen_at = NULL WHERE id = ? AND recovery_first_seen_at IS NOT NULL")
          .bind(command.id);
      case "delete-event":
        return db.prepare("DELETE FROM depeg_events WHERE id = ?").bind(command.id);
    }
  });
}

export async function persistDepegCommands(
  db: D1Database,
  commands: DepegPersistenceCommand[],
): Promise<number> {
  if (commands.length === 0) return 0;
  const statements = buildDepegPersistenceStatements(db, commands);
  await batchExecute(db, statements);
  return statements.length;
}
