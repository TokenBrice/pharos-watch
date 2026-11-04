import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEndpointDefinitionByKey, type EndpointDefinition, type EndpointKey } from "@shared/lib/api-endpoints";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
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

const fixtures = createLatestSchemaFixtureTracker();

function openAudit() {
  const sqlite = fixtures.open().sqlite;
  const db = createSqliteD1(sqlite);
  return {
    sqlite, db,
    audit: (request: Request, response: Response, definition = endpoint("remediate-blacklist-amount-gaps")) =>
      auditCatalogActionResponse({ db, endpoint: definition, request, response }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

describe("catalog action canonical audit", () => {
  // One request form per boolean spelling: the audited mode comes from the
  // response.dryRun branch, so numeric 1/0 duplicates are decoys.
  it.each([
    ["", false, "live"],
    ["?dryRun=true", true, "dry-run"],
    ["?dryRun=false", false, "live"],
  ] as const)("audits the repair handler's resolved mode for %s", async (query, dryRun, mode) => {
    const { sqlite, audit } = openAudit();
    const response = Response.json({ dryRun, privateResult: "not-persisted" });
    await audit(
      request(`/api/remediate-blacklist-amount-gaps${query}`, "mode-intent", { body: JSON.stringify({ dryRun: !dryRun }) }),
      response,
    );
    expect(JSON.parse(rows(sqlite)[0]!.details_json!)).toMatchObject({ mode });
    expect(rows(sqlite)[0]!.details_json).not.toContain("not-persisted");
    expect(await response.json()).toMatchObject({ dryRun });
  });

  it("audits a POST dry run with the handler's resolved mode", async () => {
    const { sqlite, audit } = openAudit();
    await audit(
      request("/api/backfill-dews?repair=prune-history&dry-run=true", "dews-prune-dry-run"),
      Response.json({ repair: "prune-history", dryRun: true }),
      endpoint("backfill-dews"),
    );
    expect(JSON.parse(rows(sqlite)[0]!.details_json!)).toMatchObject({ method: "POST", mode: "dry-run" });
  });

  it("keeps the GET preview inspect verdict when the handler returns a resolved dryRun flag", async () => {
    const { sqlite, audit } = openAudit();
    await audit(
      request("/api/backfill-dews?repair=prune-history&dry-run=true", "dews-prune-preview", { method: "GET" }),
      Response.json({ repair: "prune-history", dryRun: true }),
      endpoint("backfill-dews"),
    );
    expect(JSON.parse(rows(sqlite)[0]!.details_json!)).toMatchObject({ method: "GET", mode: "inspect" });
  });

  it("persists a later same-key success over an earlier headerless failure", async () => {
    const { sqlite, audit } = openAudit();
    const definition = endpoint("debug-sync-state");
    const req = request("/api/debug-sync-state", "retry-same-intent", { method: "GET" });

    await audit(
      req,
      Response.json({ error: "D1 read failed" }, { status: 500 }),
      definition,
    );
    await audit(
      req,
      Response.json({ ok: true }, { status: 200 }),
      definition,
    );

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "ok", http_status: 200 });
    expect(JSON.parse(auditRows[0]!.details_json!)).toMatchObject({ outcome: "succeeded" });
  });

  it("records only allowlisted scope and outcome metadata", async () => {
    const { sqlite, audit } = openAudit();
    const plaintextBodySecret = "plaintext-body-secret";
    const authSecret = "bearer-auth-secret";
    const querySecret = "query-secret";
    const responseSecret = "response-secret";
    const req = request(
      `/api/remediate-blacklist-amount-gaps?stablecoin=USDT&dryRun=false&apiKey=${querySecret}`,
      "repair-intent-1",
      {
        body: JSON.stringify({ token: plaintextBodySecret }),
        headers: { Authorization: `Bearer ${authSecret}` },
      },
    );

    await audit(req, Response.json({ ok: true, token: responseSecret }));

    const [row] = rows(sqlite);
    expect(row).toMatchObject({
      action: "remediate-blacklist-amount-gaps",
      target: "USDT",
      result: "ok",
      http_status: 200,
    });
    expect(row.intent_key).toMatch(/^catalog:v1:[a-f0-9]{64}$/u);
    const details = JSON.parse(row.details_json ?? "null") as Record<string, unknown>;
    expect(details).toMatchObject({
      path: "/api/remediate-blacklist-amount-gaps",
      method: "POST",
      mode: "live",
      outcome: "succeeded",
      executionCertainty: "confirmed",
      idempotentReplay: false,
      scope: { type: "asset-or-batch", label: "Stablecoin symbol" },
    });
    const persisted = JSON.stringify(row);
    expect(persisted).not.toContain("repair-intent-1");
    expect(persisted).not.toContain(plaintextBodySecret);
    expect(persisted).not.toContain(authSecret);
    expect(persisted).not.toContain(querySecret);
    expect(persisted).not.toContain(responseSecret);
  });

  it("keeps one row for a same-key replay and adds a row for an explicit new intent", async () => {
    const { sqlite, audit } = openAudit();

    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=true", "same-intent"),
      Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    );
    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=true", "same-intent"),
      Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "true" } }),
    );
    await audit(request("/api/remediate-blacklist-amount-gaps?dryRun=true", "new-intent"), Response.json({ ok: true }));

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(2);
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({ idempotentReplay: false });
  });

  it("lets a replay backfill a transiently missing first audit", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sqlite, db, audit } = openAudit();
    // Model the table being transiently absent by dropping the real one and
    // restoring its production DDL verbatim mid-test.
    const auditDdl = (sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'admin_action_audit' AND sql IS NOT NULL")
      .all() as Array<{ sql: string }>)
      .map((row) => `${row.sql};`)
      .join("\n");
    sqlite.exec("DROP TABLE admin_action_audit");
    const definition = endpoint("remediate-blacklist-amount-gaps");
    const req = request("/api/remediate-blacklist-amount-gaps?dryRun=true", "reconcile-intent");

    const firstAudited = await auditCatalogActionResponseSafely({
      db,
      endpoint: definition,
      request: req,
      response: Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    });
    expect(firstAudited).toBe(false);
    sqlite.exec(auditDdl);
    await audit(
      req,
      Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "true" } }),
      definition,
    );

    expect(rows(sqlite)).toHaveLength(1);
    expect(JSON.parse(rows(sqlite)[0]?.details_json ?? "null")).toMatchObject({ idempotentReplay: true });
    expect(warning).toHaveBeenCalled();
  });

  it("does not let a pre-idempotency failure replace the original intent outcome", async () => {
    const { sqlite, audit } = openAudit();
    const intentKey = "operator-known-idempotency-key";

    await audit(
      request("/api/remediate-blacklist-amount-gaps?stablecoin=USDT&dryRun=false", intentKey),
      Response.json({ ok: true }, { status: 200, headers: { "X-Idempotent-Replay": "false" } }),
    );
    await audit(
      request("/api/remediate-blacklist-amount-gaps?stablecoin=attacker-target&dryRun=false", intentKey, {
        headers: {
          "X-Pharos-Admin": "",
          "Cf-Access-Authenticated-User-Email": "attacker@pharos.watch",
        },
      }),
      Response.json(
        { error: "Missing required X-Pharos-Admin header; refusing mutation." },
        { status: 403 },
      ),
    );

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      target: "USDT",
      result: "ok",
      http_status: 200,
    });
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({
      outcome: "succeeded",
      idempotentReplay: false,
    });
  });

  it("lets the original success replace an earlier replay-unknown placeholder", async () => {
    const { sqlite, audit } = openAudit();
    const req = request("/api/remediate-blacklist-amount-gaps?dryRun=false", "racing-intent");

    await audit(
      req,
      Response.json(
        { error: "execution_unknown" },
        {
          status: 503,
          headers: {
            "X-Execution-Certainty": "unknown",
            "X-Idempotent-Replay": "true",
          },
        },
      ),
    );
    await audit(req, Response.json({ ok: true }, { status: 200, headers: { "X-Idempotent-Replay": "false" } }));

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "ok", http_status: 200 });
    expect(JSON.parse(auditRows[0]?.details_json ?? "null")).toMatchObject({
      outcome: "succeeded",
      executionCertainty: "confirmed",
      idempotentReplay: false,
    });
  });

  it("keeps a completed intent row when the same key is executed again", async () => {
    const { sqlite, audit } = openAudit();

    await audit(
      request("/api/remediate-blacklist-amount-gaps?stablecoin=USDT&dryRun=false", "reused-intent", {
        headers: { "Cf-Access-Authenticated-User-Email": "alice@pharos.watch" },
      }),
      Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    );
    const original = sqlite
      .prepare("SELECT created_at, actor, target FROM admin_action_audit ORDER BY id")
      .get() as { created_at: number; actor: string; target: string };

    await audit(
      request("/api/remediate-blacklist-amount-gaps?stablecoin=DAI&dryRun=true", "reused-intent", {
        headers: { "Cf-Access-Authenticated-User-Email": "bob@pharos.watch" },
      }),
      Response.json({ ok: true }, { headers: { "X-Idempotent-Replay": "false" } }),
    );

    const auditRows = sqlite
      .prepare("SELECT created_at, actor, target FROM admin_action_audit ORDER BY id")
      .all() as Array<{ created_at: number; actor: string; target: string }>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows[0]).toEqual(original);
    expect(auditRows[1]).toMatchObject({ actor: "bob@pharos.watch", target: "DAI" });
  });

  it("distinguishes an absent batch target from an unsafe configured target", async () => {
    const { sqlite, audit } = openAudit();
    const unsafeTarget = "../../secret-token";

    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=true", "batch-intent"),
      Response.json({ ok: true }),
    );
    await audit(
      request(
        `/api/remediate-blacklist-amount-gaps?dryRun=true&stablecoin=${encodeURIComponent(unsafeTarget)}`,
        "invalid-target-intent",
      ),
      Response.json({ error: "invalid_target" }, { status: 400 }),
    );

    const auditRows = rows(sqlite);
    expect(auditRows.map((row) => row.target)).toEqual(["batch", "invalid-target"]);
    expect(JSON.stringify(auditRows)).not.toContain(unsafeTarget);
  });

  it("does not let a request-mismatch conflict replace the original intent outcome", async () => {
    const { sqlite, audit } = openAudit();

    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=false", "conflict-intent"),
      Response.json({ ok: true }),
    );
    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=false&stablecoin=other", "conflict-intent"),
      Response.json(
        { error: "Idempotency key reuse with different request payload" },
        {
          status: 409,
          headers: {
            "X-Idempotent-Replay": "true",
            "X-Idempotency-Conflict": "request-mismatch",
          },
        },
      ),
    );

    const auditRows = rows(sqlite);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ result: "ok", http_status: 200, target: "batch" });
  });

  it("classifies accepted, queued, definite-error, and execution-unknown outcomes", async () => {
    const { sqlite, db } = openAudit();
    const cases = [
      {
        endpoint: endpoint("remediate-blacklist-amount-gaps"),
        request: request("/api/remediate-blacklist-amount-gaps", "accepted-intent"),
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
        endpoint: endpoint("remediate-blacklist-amount-gaps"),
        request: request("/api/remediate-blacklist-amount-gaps", "failed-intent"),
        response: Response.json({ error: "invalid_scope" }, { status: 422 }),
        outcome: "failed",
        result: "error",
      },
      {
        endpoint: endpoint("remediate-blacklist-amount-gaps"),
        request: request("/api/remediate-blacklist-amount-gaps", "unknown-intent"),
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

  it("records a headerless 5xx as unknown execution certainty", async () => {
    const { sqlite, audit } = openAudit();

    await audit(
      request("/api/remediate-blacklist-amount-gaps?dryRun=false", "thrown-intent"),
      Response.json({ error: "InternalError" }, { status: 500 }),
    );

    expect(JSON.parse(rows(sqlite)[0]?.details_json ?? "null")).toMatchObject({
      outcome: "failed",
      executionCertainty: "unknown",
    });
  });

  it("leaves richer handler-owned auditing to the handler", async () => {
    const { sqlite, audit } = openAudit();
    const canonical = endpoint("trigger-digest");
    const handlerOwned: EndpointDefinition = {
      ...canonical,
      statusPageAction: { ...canonical.statusPageAction!, auditMode: "handler" },
    };

    expect(getCatalogActionAuditOwner(handlerOwned)).toBe("handler");
    await audit(
      request("/api/trigger-digest", "handler-intent"),
      Response.json({ accepted: true }, { status: 202 }),
      handlerOwned,
    );
    expect(rows(sqlite)).toEqual([]);
  });
});
