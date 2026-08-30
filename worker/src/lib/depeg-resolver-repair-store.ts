import { assertNonEmpty, assertPositiveInteger } from "./depeg-resolver-store-validators";

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

export type RepairAuthorizationIdentity = Pick<AuthorizeEventRepairInput, "eventId" | "incidentKey" | "operation" | "createdAt" | "expiresAt" | "createdBy">;

export interface ConsumeEventRepairAuthorizationInput {
  authorizationId: number;
  eventId: number;
  incidentKey: string;
  operation: DdrRepairOperation;
  consumedAt: number;
  consumer: string;
}

type RepairAuthorizationConsumptionIdentity = RepairAuthorizationIdentity | Pick<ConsumeEventRepairAuthorizationInput, "authorizationId" | "eventId" | "incidentKey" | "operation">;

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

function authorizationIdentityWhereSql(alias: string): string {
  return `${alias}.event_id = ? AND ${alias}.incident_key = ? AND ${alias}.operation = ? AND ${alias}.created_at = ? AND ${alias}.expires_at = ? AND ${alias}.created_by = ?`;
}

export function repairAuthorizationIdentityBinds(identity: RepairAuthorizationIdentity): unknown[] { return [identity.eventId, identity.incidentKey, identity.operation, identity.createdAt, identity.expiresAt, identity.createdBy]; }

export function prepareRepairAuthorization(db: D1Database, input: AuthorizeEventRepairInput, guard?: { sql: string; binds: readonly unknown[] }): D1PreparedStatement {
  const columnsJson = JSON.stringify([...new Set(input.columns)].sort()), createdAtSql = guard == null ? "?" : `CASE WHEN ${guard.sql} THEN ? ELSE 0 END`;
  return db.prepare(`INSERT INTO depeg_resolver_event_repair_authorizations
    (event_id, incident_key, operation, columns_json, required_revision_id, required_erratum_id, reason, created_at, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ${createdAtSql}, ?, ?) RETURNING *`).bind(
    input.eventId, input.incidentKey, input.operation, columnsJson, input.requiredRevisionId ?? null, input.requiredErratumId ?? null, input.reason,
    ...(guard?.binds ?? []), input.createdAt, input.expiresAt, input.createdBy,
  );
}

export function prepareRepairAuthorizationConsumption(db: D1Database, identity: RepairAuthorizationConsumptionIdentity, consumedAt: number, consumer: string): D1PreparedStatement {
  const byId = "authorizationId" in identity;
  const whereSql = byId ? "authorization.id = ? AND authorization.event_id = ? AND authorization.incident_key = ? AND authorization.operation = ?" : authorizationIdentityWhereSql("authorization");
  const identityBinds = byId ? [identity.authorizationId, identity.eventId, identity.incidentKey, identity.operation] : repairAuthorizationIdentityBinds(identity);
  return db.prepare(`INSERT INTO depeg_resolver_event_repair_authorization_consumptions
    (authorization_id, event_id, incident_key, operation, consumed_at, consumer)
    SELECT authorization.id, authorization.event_id, authorization.incident_key, authorization.operation, ?, ?
    FROM depeg_resolver_event_repair_authorizations authorization WHERE ${whereSql} AND authorization.expires_at >= ?`).bind(consumedAt, consumer, ...identityBinds, consumedAt);
}

export function repairAuthorizationIdSubquery(alias = "authorization"): string {
  return `(SELECT ${alias}.id FROM depeg_resolver_event_repair_authorizations ${alias} WHERE ${authorizationIdentityWhereSql(alias)} LIMIT 1)`;
}

export function repairAuthorizationConsumedPredicate(alias = "authorization"): string {
  return `EXISTS (SELECT 1 FROM depeg_resolver_event_repair_authorizations ${alias} JOIN depeg_resolver_event_repair_authorization_consumptions consumption ON consumption.authorization_id = ${alias}.id AND consumption.event_id = ${alias}.event_id AND consumption.incident_key = ${alias}.incident_key AND consumption.operation = ${alias}.operation WHERE ${authorizationIdentityWhereSql(alias)})`;
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

  const row = await prepareRepairAuthorization(db, input).first<AuthorizationRow>();
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

  const result = await prepareRepairAuthorizationConsumption(
    db,
    input,
    input.consumedAt,
    input.consumer,
  ).run();

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
