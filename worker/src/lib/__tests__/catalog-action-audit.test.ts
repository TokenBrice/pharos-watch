import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEndpointDefinitionByKey, type EndpointDefinition, type EndpointKey } from "@shared/lib/api-endpoints";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  auditCatalogActionResponse,
  auditCatalogActionResponseSafely,
  getCatalogActionAuditOwner,
} from "../catalog-action-audit";


interface AuditRow {
  action: string;
  target: string | null;
  result: "ok" | "error";
  http_status: number | null;
  details_json: string | null;
  intent_key: string | null;
}

function endpoint(key: EndpointKey): EndpointDefinition {
  const definition = getEndpointDefinitionByKey(key);
  if (!definition) throw new Error(`Missing endpoint ${key}`);
  return definition;
}

function request(path: string, key: string, init: RequestInit = {}): Request {
  return new Request(`https://ops-api.pharos.watch${path}`, {
    method: "POST",
    ...init,
    headers: {
      "X-Pharos-Admin": "1",
      "Idempotency-Key": key,
      "Cf-Access-Authenticated-User-Email": "operator@pharos.watch",
      ...(init.headers ?? {}),
    },
  });
}

function rows(sqlite: DatabaseSync): AuditRow[] {
  return sqlite
    .prepare("SELECT action, target, result, http_status, details_json, intent_key FROM admin_action_audit ORDER BY id")
    .all() as unknown as AuditRow[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("catalog action canonical audit", () => {
  it("records only allowlisted scope and outcome metadata", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const plaintextBodySecret = "plaintext-body-secret";
    const authSecret = "bearer-auth-secret";
    const querySecret = "query-secret";
    const responseSecret = "response-secret";
    const req = request(
      `/api/backfill-depegs?stablecoin=usdt-tether&dry-run=false&apiKey=${querySecret}`,
      "repair-intent-1",
      {
        body: JSON.stringify({ token: plaintextBodySecret }),
        headers: { Authorization: `Bearer ${authSecret}` },
      },
    );

    await auditCatalogActionResponse({
      db,
      endpoint: endpoint("backfill-depegs"),
      request: req,
      response: Response.json({ ok: true, token: responseSecret }),
    });

    const [row] = rows(sqlite);
    expect(row).toMatchObject({
      action: "backfill-depegs",
      target: "usdt-tether",
      result: "ok",
      http_status: 200,
    });
    expect(row.intent_key).toMatch(/^catalog:v1:[a-f0-9]{64}$/u);
    const details = JSON.parse(row.details_json ?? "null") as Record<string, unknown>;
    expect(details).toMatchObject({
      path: "/api/backfill-depegs",
      method: "POST",
      mode: "live",
      outcome: "succeeded",
      executionCertainty: "confirmed",
      idempotentReplay: false,
      scope: { type: "asset-or-batch", label: "Stablecoin ID" },
    });
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain("repair-intent-1");
    expect(persisted).not.toContain(plaintextBodySecret);
    expect(persisted).not.toContain(authSecret);
    expect(persisted).not.toContain(querySecret);
    expect(persisted).not.toContain(responseSecret);
  });

  it("keeps one row for a same-key replay and adds a row for an explicit new intent", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");

    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=true", "same-intent"),
      response: Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=true", "same-intent"),
      response: Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "true" } }),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=true", "new-intent"),
      response: Response.json({ ok: true }),
    });

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(2);
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({ idempotentReplay: false });
  });

  it("lets a replay backfill a transiently missing first audit", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sqlite = createLatestSchemaSqlite().sqlite;
    // Model the table being transiently absent by dropping the real one and
    // restoring its production DDL verbatim mid-test.
    const auditDdl = (sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'admin_action_audit' AND sql IS NOT NULL")
      .all() as Array<{ sql: string }>)
      .map((row) => `${row.sql};`)
      .join("\n");
    sqlite.exec("DROP TABLE admin_action_audit");
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");
    const req = request("/api/backfill-depegs?dry-run=true", "reconcile-intent");

    const firstAudited = await auditCatalogActionResponseSafely({
      db,
      endpoint: definition,
      request: req,
      response: Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    });
    expect(firstAudited).toBe(false);
    sqlite.exec(auditDdl);
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: req,
      response: Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "true" } }),
    });

    expect(rows(sqlite)).toHaveLength(1);
    expect(JSON.parse(rows(sqlite)[0]?.details_json ?? "null")).toMatchObject({ idempotentReplay: true });
    expect(warning).toHaveBeenCalled();
  });

  it("records an explicit mint/burn live request as live despite preview-only catalog metadata", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);

    await auditCatalogActionResponse({
      db,
      endpoint: endpoint("backfill-mint-burn-prices"),
      request: request("/api/backfill-mint-burn-prices?dry-run=false", "mint-price-live"),
      response: Response.json({ ok: true }),
    });

    expect(JSON.parse(rows(sqlite)[0]?.details_json ?? "null")).toMatchObject({ mode: "live" });
  });

  it("does not let a pre-idempotency failure replace the original intent outcome", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");
    const intentKey = "operator-known-idempotency-key";

    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?stablecoin=usdt-tether&dry-run=false", intentKey),
      response: Response.json({ ok: true }, { status: 200, headers: { "X-Idempotent-Replay": "false" } }),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?stablecoin=attacker-target&dry-run=false", intentKey, {
        headers: {
          "X-Pharos-Admin": "",
          "Cf-Access-Authenticated-User-Email": "attacker@pharos.watch",
        },
      }),
      response: Response.json(
        { error: "Missing required X-Pharos-Admin header; refusing mutation." },
        { status: 403 },
      ),
    });

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      target: "usdt-tether",
      result: "ok",
      http_status: 200,
    });
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({
      outcome: "succeeded",
      idempotentReplay: false,
    });
  });

  it("lets the original success replace an earlier replay-unknown placeholder", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");
    const req = request("/api/backfill-depegs?dry-run=false", "racing-intent");

    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: req,
      response: Response.json(
        { error: "execution_unknown" },
        {
          status: 503,
          headers: {
            "X-Execution-Certainty": "unknown",
            "X-Idempotent-Replay": "true",
          },
        },
      ),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: req,
      response: Response.json({ ok: true }, { status: 200, headers: { "X-Idempotent-Replay": "false" } }),
    });

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "ok", http_status: 200 });
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({
      outcome: "succeeded",
      executionCertainty: "confirmed",
      idempotentReplay: false,
    });
  });

  it("distinguishes an absent batch target from an unsafe configured target", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");
    const unsafeTarget = "../../secret-token";

    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=true", "batch-intent"),
      response: Response.json({ ok: true }),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request(
        `/api/backfill-depegs?dry-run=true&stablecoin=${encodeURIComponent(unsafeTarget)}`,
        "invalid-target-intent",
      ),
      response: Response.json({ error: "invalid_target" }, { status: 400 }),
    });

    const auditRows = rows(sqlite);
    expect(auditRows.map((row) => row.target)).toEqual(["batch", "invalid-target"]);
    expect(JSON.stringify(auditRows)).not.toContain(unsafeTarget);
  });

  it("does not let a request-mismatch conflict replace the original intent outcome", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const definition = endpoint("backfill-depegs");

    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=false", "conflict-intent"),
      response: Response.json({ ok: true }),
    });
    await auditCatalogActionResponse({
      db,
      endpoint: definition,
      request: request("/api/backfill-depegs?dry-run=false&stablecoin=other", "conflict-intent"),
      response: Response.json(
        { error: "Idempotency key reuse with different request payload" },
        {
          status: 409,
          headers: {
            "X-Idempotent-Replay": "true",
            "X-Idempotency-Conflict": "request-mismatch",
          },
        },
      ),
    });

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "ok", http_status: 200, target: "batch" });
  });

  it("classifies accepted, queued, definite-error, and execution-unknown outcomes", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const cases = [
      {
        endpoint: endpoint("backfill-depegs"),
        request: request("/api/backfill-depegs", "accepted-intent"),
        response: Response.json({ accepted: true }, { status: 202 }),
        outcome: "accepted",
        result: "ok",
      },
      {
        endpoint: endpoint("trigger-digest"),
        request: request("/api/trigger-digest", "queued-intent"),
        response: Response.json({ accepted: true }, { status: 202 }),
        outcome: "queued",
        result: "ok",
      },
      {
        endpoint: endpoint("backfill-depegs"),
        request: request("/api/backfill-depegs", "failed-intent"),
        response: Response.json({ error: "invalid_scope" }, { status: 422 }),
        outcome: "failed",
        result: "error",
      },
      {
        endpoint: endpoint("backfill-depegs"),
        request: request("/api/backfill-depegs", "unknown-intent"),
        response: Response.json(
          { error: "execution_unknown" },
          { status: 503, headers: { "X-Execution-Certainty": "unknown" } },
        ),
        outcome: "unknown",
        result: "error",
      },
    ] as const;

    for (const testCase of cases) {
      await auditCatalogActionResponse({ db, ...testCase });
    }

    expect(
      rows(sqlite).map((row) => ({
        outcome: (JSON.parse(row.details_json ?? "null") as { outcome: string }).outcome,
        result: row.result,
        status: row.http_status,
      })),
    ).toEqual([
      { outcome: "accepted", result: "ok", status: 202 },
      { outcome: "queued", result: "ok", status: 202 },
      { outcome: "failed", result: "error", status: 422 },
      { outcome: "unknown", result: "error", status: 503 },
    ]);
  });

  it("leaves richer handler-owned auditing to the handler", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const canonical = endpoint("trigger-digest");
    const handlerOwned: EndpointDefinition = {
      ...canonical,
      statusPageAction: { ...canonical.statusPageAction!, auditMode: "handler" },
    };

    expect(getCatalogActionAuditOwner(handlerOwned)).toBe("handler");
    await auditCatalogActionResponse({
      db,
      endpoint: handlerOwned,
      request: request("/api/trigger-digest", "handler-intent"),
      response: Response.json({ accepted: true }, { status: 202 }),
    });
    expect(rows(sqlite)).toEqual([]);
  });
});
