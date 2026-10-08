import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { commandPlan, pairedBaselineDate, parseArgs, qualificationComplete, WORKER_CONFIGS } from "../maintenance/benchmark-worker-compatibility-date";
import { assertHeavyNeutralProof, assertHeavySmokeWindow, isolatedEntrySource, isolatedSmokeConfig, nextHeavySmokeWindow, selectSmokeConfig } from "../lib/worker-compatibility-smoke.mjs";

const results = () => (["public", "heavy"] as const).flatMap((role) => (["baseline", "candidate"] as const).map((label) => ({
  role, label, config: WORKER_CONFIGS[role], date: label === "baseline" ? "2026-04-18" : "2026-10-08", bundleBytes: 1,
  checks: [], bundle: "passed" as const, startup: "passed" as const, smoke: "passed" as const, error: null,
})));

describe("compatibility date qualification", () => {
  it("constructs four role/date local-only bundle and startup plans", () => {
    const plans = results().map(({ role, label, date }) => commandPlan(role, date, `/tmp/${role}-${label}.mjs`, true));
    expect(plans).toHaveLength(4);
    for (const [index, plan] of plans.entries()) {
      expect(plan).toHaveLength(3);
      expect(plan[0][1]).toContain(WORKER_CONFIGS[results()[index].role]);
      expect(plan[0][1]).toContain("--dry-run");
      expect(plan[0][1]).toContain(results()[index].date);
      expect(plan[1][1]).toContain("startup");
      expect(plan[2]).toEqual(["node", ["scripts/maintenance/run-worker-smoke.mjs"]]);
    }
  });

  it("requires every role/date bundle, startup and smoke outcome", () => {
    expect(qualificationComplete(results())).toBe(true);
    expect(qualificationComplete(results().slice(1))).toBe(false);
    expect(qualificationComplete([...results(), results()[0]])).toBe(false);
    for (const stage of ["bundle", "startup", "smoke"] as const) {
      expect(qualificationComplete(results().map((row, index) => index === 3 ? { ...row, [stage]: "skipped" } : row))).toBe(false);
      expect(qualificationComplete(results().map((row, index) => index === 0 ? { ...row, [stage]: "failed" } : row))).toBe(false);
    }
    expect(commandPlan("heavy", "2026-10-08", "/tmp/heavy.mjs", false)).toHaveLength(2);
  });

  it("rejects paired baseline drift and strict CLI mistakes", () => {
    expect(pairedBaselineDate('compatibility_date = "2026-04-18"', 'compatibility_date = "2026-04-18"')).toBe("2026-04-18");
    expect(() => pairedBaselineDate('compatibility_date = "2026-04-18"', 'compatibility_date = "2026-04-19"')).toThrow(/must match/);
    expect(() => parseArgs(["--candidate-date", "2026-10-08", "--typo"])).toThrow();
    expect(() => parseArgs(["--candidate-date", "2026-10-08", "--candidate-date", "2026-10-09"])).toThrow();
  });
});

describe("isolated Heavy compatibility smoke", () => {
  it("selects the correct role and forbids arbitrary configs", () => {
    expect(selectSmokeConfig("worker/wrangler.heavy.toml", "scheduled-heavy")).toMatch(/wrangler\.heavy\.toml$/);
    expect(() => selectSmokeConfig("worker/wrangler.heavy.toml", "runtime")).toThrow();
    expect(() => selectSmokeConfig("worker/wrangler.toml", "scheduled-heavy")).toThrow();
    expect(() => selectSmokeConfig("/tmp/remote.toml", "runtime")).toThrow();
  });

  it("creates a copied-runtime local config without production bindings or credentials", () => {
    const config = isolatedSmokeConfig(readFileSync("worker/wrangler.heavy.toml", "utf8"), selectSmokeConfig("worker/wrangler.heavy.toml", "scheduled-heavy"), "/tmp/entry.mjs", "2026-10-08");
    expect(config).toMatchObject({ workers_dev: false, preview_urls: false, compatibility_date: "2026-10-08", version_metadata: { binding: "CF_VERSION_METADATA" } });
    expect(config.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
    expect(config).not.toHaveProperty("vars");
    expect(config).not.toHaveProperty("workflows");
    expect(config.d1_databases[0].migrations_dir).toMatch(/worker\/migrations$/);
    const entry = isolatedEntrySource("/repo/worker/src/index.heavy.ts", true);
    expect(entry).toContain("worker.scheduled(controller, isolatedEnv(env), ctx)");
    expect(entry).toContain("WORKER_SMOKE_BLOCKED_EGRESS");
    expect(entry).toContain("WORKER_SMOKE_BLOCKED_BUSINESS_WRITE");
    expect(entry).not.toContain("worker.fetch(");
  });

  it("uses a real UTC :08 window and rejects stale or premature invocations", () => {
    const now = Date.parse("2026-10-08T12:09:00Z");
    const window = nextHeavySmokeWindow(now);
    expect(window.scheduledTimeMs).toBe(Date.parse("2026-10-08T13:08:00Z"));
    expect(() => assertHeavySmokeWindow(window, window.scheduledTimeMs)).not.toThrow();
    expect(() => assertHeavySmokeWindow(window, window.deadlineMs - 60_000)).not.toThrow();
    expect(() => assertHeavySmokeWindow(window, now)).toThrow();
    expect(() => assertHeavySmokeWindow(window, window.deadlineMs - 59_999)).toThrow();
  });

  it("distinguishes the neutral child from an ok enclosing parent and rejects incomplete proof", () => {
    const parent = { state: "finished", result_status: "ok", worker_version: "local-v1" };
    const metadata = { reason: "v9-core-slot-not-ready", coreState: null, coreResultStatus: null, coreWorkerVersion: null,
      expectedWorkerVersion: "local-v1", coreStablecoinsPublicationMatched: false, degradedCorePublicationMatched: false };
    const child = { status: "skipped_neutral", productive: 0, item_count: 0, degraded_reason: "v9-core-slot-not-ready", metadata: JSON.stringify(metadata) };
    const counts = { core: 0, publications: 0, active: 0, memory: 0, business: 0 };
    expect(assertHeavyNeutralProof(parent, child, counts)).toMatchObject({ parentResultStatus: "ok", childStatus: "skipped_neutral", callbackReached: false,
      productivity: { productive: false, reason: "v9-core-slot-not-ready" } });
    expect(() => assertHeavyNeutralProof({ ...parent, result_status: "degraded" }, child, counts)).toThrow();
    expect(() => assertHeavyNeutralProof(parent, { ...child, status: "ok" }, counts)).toThrow();
    expect(() => assertHeavyNeutralProof(parent, { ...child, metadata: JSON.stringify({ ...metadata, expectedWorkerVersion: "" }) }, counts)).toThrow();
    expect(() => assertHeavyNeutralProof(parent, child, { ...counts, business: 1 })).toThrow();
    expect(() => assertHeavyNeutralProof(parent, null, counts)).toThrow();
  });
});
