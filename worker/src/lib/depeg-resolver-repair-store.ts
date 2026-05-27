export type DdrRepairOperation =
  | "identity_update"
  | "delete"
  | "incident_link"
  | "incident_current_update"
  | "provenance_invalidation";

export interface AuthorizeEventRepairInput {
  eventId: number;
  incidentKey: string;
  operation: DdrRepairOperation;
  columns: string[];
  requiredRevisionId?: number | null;
  requiredErratumId?: number | null;
  reason: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
}

export interface ConsumeEventRepairAuthorizationInput {
  authorizationId: number;
  eventId: number;
  incidentKey: string;
  operation: DdrRepairOperation;
  consumedAt: number;
  consumer: string;
}

export interface DdrEventRepairAuthorization {
  id: number;
  eventId: number;
  incidentKey: string;
  operation: DdrRepairOperation;
  columnsJson: string;
  requiredRevisionId: number | null;
  requiredErratumId: number | null;
  reason: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string;
}

export interface DdrEventRepairAuthorizationConsumption {
  authorizationId: number;
  eventId: number;
  incidentKey: string;
  operation: DdrRepairOperation;
  consumedAt: number;
  consumer: string;
}

interface AuthorizationRow {
  id: number;
  event_id: number;
  incident_key: string;
  operation: DdrRepairOperation;
  columns_json: string;
  required_revision_id: number | null;
  required_erratum_id: number | null;
  reason: string;
  created_at: number;
  expires_at: number;
  created_by: string;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function mapAuthorization(row: AuthorizationRow): DdrEventRepairAuthorization {
  return {
    id: row.id,
    eventId: row.event_id,
    incidentKey: row.incident_key,
    operation: row.operation,
    columnsJson: row.columns_json,
    requiredRevisionId: row.required_revision_id,
    requiredErratumId: row.required_erratum_id,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
  };
}

export async function authorizeEventRepair(
  db: D1Database,
  input: AuthorizeEventRepairInput,
): Promise<DdrEventRepairAuthorization> {
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.createdAt, "createdAt");
  assertPositiveInteger(input.expiresAt, "expiresAt");
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertNonEmpty(input.reason, "reason");
  assertNonEmpty(input.createdBy, "createdBy");
  if (input.expiresAt < input.createdAt) throw new Error("expiresAt must be at or after createdAt");
  for (const column of input.columns) assertNonEmpty(column, "columns[]");
  if (input.requiredRevisionId != null) assertPositiveInteger(input.requiredRevisionId, "requiredRevisionId");
  if (input.requiredErratumId != null) assertPositiveInteger(input.requiredErratumId, "requiredErratumId");

  const columnsJson = JSON.stringify([...new Set(input.columns)].sort());
  await db
    .prepare(
      `INSERT INTO depeg_resolver_event_repair_authorizations
       (event_id, incident_key, operation, columns_json, required_revision_id,
        required_erratum_id, reason, created_at, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.eventId,
      input.incidentKey,
      input.operation,
      columnsJson,
      input.requiredRevisionId ?? null,
      input.requiredErratumId ?? null,
      input.reason,
      input.createdAt,
      input.expiresAt,
      input.createdBy,
    )
    .run();

  const row = await db
    .prepare(
      `SELECT *
       FROM depeg_resolver_event_repair_authorizations
       WHERE event_id = ?
         AND incident_key = ?
         AND operation = ?
         AND columns_json = ?
         AND created_at = ?
         AND expires_at = ?
         AND created_by = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(
      input.eventId,
      input.incidentKey,
      input.operation,
      columnsJson,
      input.createdAt,
      input.expiresAt,
      input.createdBy,
    )
    .first<AuthorizationRow>();
  if (!row) throw new Error("repair authorization insert could not be reloaded");
  return mapAuthorization(row);
}

export async function consumeEventRepairAuthorization(
  db: D1Database,
  input: ConsumeEventRepairAuthorizationInput,
): Promise<DdrEventRepairAuthorizationConsumption> {
  assertPositiveInteger(input.authorizationId, "authorizationId");
  assertPositiveInteger(input.eventId, "eventId");
  assertPositiveInteger(input.consumedAt, "consumedAt");
  assertNonEmpty(input.incidentKey, "incidentKey");
  assertNonEmpty(input.consumer, "consumer");

  const result = await db
    .prepare(
      `INSERT INTO depeg_resolver_event_repair_authorization_consumptions
       (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
       SELECT id, event_id, incident_key, operation, ?, ?
       FROM depeg_resolver_event_repair_authorizations
       WHERE id = ?
         AND event_id = ?
         AND incident_key = ?
         AND operation = ?
         AND expires_at >= ?`,
    )
    .bind(
      input.consumedAt,
      input.consumer,
      input.authorizationId,
      input.eventId,
      input.incidentKey,
      input.operation,
      input.consumedAt,
    )
    .run();

  if (Number(result.meta?.changes ?? 0) !== 1) {
    throw new Error("repair authorization was not available for consumption");
  }

  return {
    authorizationId: input.authorizationId,
    eventId: input.eventId,
    incidentKey: input.incidentKey,
    operation: input.operation,
    consumedAt: input.consumedAt,
    consumer: input.consumer,
  };
}
