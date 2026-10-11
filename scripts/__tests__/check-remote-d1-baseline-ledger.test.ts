import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { checkRemoteD1BaselineLedger, runRemoteD1BaselinePreflight } from "../ci/check-remote-d1-baseline-ledger";

const BASELINE = "0000_baseline.sql";
const TAIL = "0228_depeg_resolver_incident_closed_pre_lock.sql";
const MIGRATIONS = [BASELINE, TAIL];

// Wrangler 4.129.0 execute --json serializes an array of successful query receipts.
function receipt(names: string[]): string {
  return JSON.stringify([{ results: names.map((name) => ({ name })), success: true, meta: { rows_read: names.length } }]);
}

const EXISTING_TABLES = receipt(["cache", "d1_migrations"]);

describe("remote D1 baseline ledger preflight", () => {
  it("allows the adopted exact baseline with only tail migrations pending", () => {
    expect(checkRemoteD1BaselineLedger(EXISTING_TABLES, receipt([BASELINE, "0072_telegram_launch_alerts.sql"]), MIGRATIONS))
      .toEqual({ status: "adopted", pendingMigrations: [TAIL] });
  });

  it("allows no unapplied migrations without treating an empty receipt as missing evidence", () => {
    expect(checkRemoteD1BaselineLedger(EXISTING_TABLES, receipt(MIGRATIONS), MIGRATIONS))
      .toEqual({ status: "adopted", pendingMigrations: [] });
  });

  it("rejects an existing ledger with the baseline pending even if absorbed filenames were applied", () => {
    expect(() => checkRemoteD1BaselineLedger(EXISTING_TABLES, receipt(["0001_initial.sql", TAIL]), MIGRATIONS))
      .toThrow(`${BASELINE} is pending on an existing database`);
  });

  it("requires exact filename membership rather than another baseline filename", () => {
    expect(() => checkRemoteD1BaselineLedger(EXISTING_TABLES, receipt(["0000_old_baseline.sql"]), MIGRATIONS))
      .toThrow("reviewed baseline-adoption plan");
  });

  it.each<[string, string | null]>([
    [receipt([]), null],
    [receipt(["d1_migrations"]), receipt([])],
  ])("allows a fresh database with no application tables and an absent or empty ledger", (tables, ledger) => {
    expect(checkRemoteD1BaselineLedger(tables, ledger, MIGRATIONS))
      .toEqual({ status: "fresh", pendingMigrations: MIGRATIONS });
  });

  it.each<[string, string | null]>([
    [EXISTING_TABLES, receipt([])],
    [receipt(["cache"]), null],
  ])("does not mistake existing application tables for a fresh empty ledger", (tables, ledger) => {
    expect(() => checkRemoteD1BaselineLedger(tables, ledger, MIGRATIONS)).toThrow("existing database");
  });

  it.each([
    "",
    " \n",
    "\u2705 No migrations to apply!",
    "Migrations to be applied:\n│ Name │\n│ 0000_baseline.sql │",
    "not-json",
    "[]",
    "{}",
    '{"error":"Authentication failed"}',
    '[{"success":false,"results":[]}]',
    '[{"success":true}]',
    '[{"success":true,"results":null}]',
    '[{"success":true,"results":[{}]}]',
    '[{"success":true,"results":[{"name":null}]}]',
    '[{"success":true,"results":[{"name":""}]}]',
    '[{"success":true,"results":[{"name":"0000_baseline.sql "}]}]',
    '[{"success":true,"results":[]},{"success":true,"results":[]}]',
    receipt([BASELINE, BASELINE]),
  ])("fails closed on malformed or unsuccessful ledger output: %s", (output) => {
    expect(() => checkRemoteD1BaselineLedger(EXISTING_TABLES, output, MIGRATIONS)).toThrow("Cannot parse remote D1");
  });

  it("fails closed on malformed table inventory even with an adopted ledger", () => {
    expect(() => checkRemoteD1BaselineLedger("[]", receipt([BASELINE]), MIGRATIONS)).toThrow("table inventory");
  });

  it.each<[string, string | null]>([
    [EXISTING_TABLES, null],
    [receipt([]), receipt([BASELINE])],
  ])("rejects missing or contradictory ledger evidence", (tables, ledger) => {
    expect(() => checkRemoteD1BaselineLedger(tables, ledger, MIGRATIONS)).toThrow("does not match");
  });

  it("rejects a local tree that lacks the exact baseline", () => {
    expect(() => checkRemoteD1BaselineLedger(EXISTING_TABLES, receipt([BASELINE]), [TAIL]))
      .toThrow("Local migration tree is missing");
  });

  it("lists pending filenames using only table and ledger SELECTs", () => {
    const query = vi.fn<(sql: string) => string>()
      .mockReturnValueOnce(EXISTING_TABLES)
      .mockReturnValueOnce(receipt([BASELINE]));
    expect(runRemoteD1BaselinePreflight(query, MIGRATIONS)).toEqual({ status: "adopted", pendingMigrations: [TAIL] });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT name FROM sqlite_master /);
    expect(query.mock.calls[0][0]).toContain("substr(name, 1, 7) != 'sqlite_'");
    expect(query.mock.calls[0][0]).toContain("name != '_cf_KV'");
    expect(query.mock.calls[1][0]).toBe('SELECT name FROM "d1_migrations" ORDER BY id;');
  });

  it("does not initialize or query an absent ledger on fresh D1", () => {
    const query = vi.fn<(sql: string) => string>().mockReturnValue(receipt([]));
    expect(runRemoteD1BaselinePreflight(query, MIGRATIONS).status).toBe("fresh");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("propagates failure of remote query %s instead of assuming no pending migrations", (failureIndex) => {
    const query = vi.fn<(sql: string) => string>((sql) => {
      if ((failureIndex === 0 && sql.includes("sqlite_master")) || (failureIndex === 1 && !sql.includes("sqlite_master"))) {
        throw new Error("Wrangler exited 1");
      }
      return EXISTING_TABLES;
    });
    expect(() => runRemoteD1BaselinePreflight(query, MIGRATIONS)).toThrow("Wrangler exited 1");
    expect(query).toHaveBeenCalledTimes(failureIndex + 1);
  });

  it("does not attempt a ledger read after an unparseable table receipt", () => {
    const query = vi.fn<(sql: string) => string>().mockReturnValue("{}");
    expect(() => runRemoteD1BaselinePreflight(query, MIGRATIONS)).toThrow("table inventory");
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("production deployment baseline gate", () => {
  it("preflights the shared D1 once immediately before applying migrations, using production credentials", () => {
    const workflow = parseYaml(readFileSync(new URL("../../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8"));
    const job = workflow.jobs["deploy-worker"];
    const steps = job.steps as Array<{ name?: string; run?: string; if?: string; "continue-on-error"?: boolean }>;
    const preflight = steps.findIndex((step) => step.run === "npm run check:remote-d1-baseline-ledger");
    const apply = steps.findIndex((step) => step.run?.includes("d1 migrations apply"));
    expect(preflight).toBeGreaterThan(steps.findIndex((step) => step.run === "npm run check:worker-package"));
    expect(apply).toBe(preflight + 1);
    expect(steps.filter((step) => step.run?.includes("d1 migrations apply"))).toHaveLength(1);
    expect(steps[preflight].if).toBeUndefined();
    expect(steps[preflight]["continue-on-error"]).not.toBe(true);
    expect(job.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    });
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["check:remote-d1-baseline-ledger"])
      .toBe("node --import tsx scripts/ci/check-remote-d1-baseline-ledger.ts");
  });
});
