import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** Apply the production outage-control migration to focused partial-schema fixtures. */
export function applyTelegramTransportControlSchema(sqlite: DatabaseSync): void {
  const migrationPath = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "src/test-helpers/migration-fixtures/0191_telegram_transport_outage_control.sql")
    : join(process.cwd(), "worker/src/test-helpers/migration-fixtures/0191_telegram_transport_outage_control.sql");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration selected above.
  sqlite.exec(readFileSync(migrationPath, "utf8"));
}
