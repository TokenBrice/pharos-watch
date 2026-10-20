import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CRON_JOB_DEFINITIONS } from "../../../shared/lib/cron-jobs";
import { summarizeWorkerEvidence, renderWorkerEvidenceTable } from "../worker-evidence-report.mjs";
import { assembleIncidentBundle, captureWorkerIncidentBundle, joinIncidentEvidence } from "../worker-incident-bundle.mjs";
import { createReadOnlyProfileDb, profileStatusRoute } from "../../../worker/scripts/worker-status-profile.mjs";

const DAY = 86400;

describe("Worker evidence literal reporting", () => {
  it("keeps every stored status and unknown productivity separate", () => {
    const summary = summarizeWorkerEvidence(["ok", "degraded", "error", "skipped_neutral", "skipped_locked", "future-status"].map((status) => ({ status })));
    expect(summary.counts).toEqual({ ok: 1, degraded: 1, error: 1, skipped_neutral: 1, skipped_locked: 1, skipped_duplicate: 0, skipped_running: 0, "future-status": 1 });
    expect(summary.productiveUnknown).toBe(6);
    expect(summary.publicationCount).toBe(0);
    expect(summary.publicationUnknown).toBe(6);
    expect(renderWorkerEvidenceTable(summary)).toContain("| degraded | 1 |");
    expect(renderWorkerEvidenceTable(summary)).toContain("| skipped_neutral | 1 |");
  });

  it("groups one started and two not-started synthetic children without changing errors", () => {
    const summary = summarizeWorkerEvidence(["abandoned", "not_started", "not_started"].map((child_disposition, index) => ({
      job: `job-${index}`, status: "error", synthetic_reason: "stale-slot-reconciled", child_disposition,
      invocation_id: "invocation", schedule_key: "lane", slot_started_at: 100, productive: 0, publication_count: 0,
    })));
    expect(summary.counts.error).toBe(3);
    expect(summary.counts.degraded).toBe(0);
    expect(summary.synthetic).toBe(3);
    expect(summary.syntheticInvocations).toHaveLength(1);
    expect(summary.syntheticInvocations[0].presentation).toBe("1 started + 2 not-started");
  });

  it("does not combine missing identities or unknown executions into started children", () => {
    const summary = summarizeWorkerEvidence([1, 2].map(() => ({ job: "job", status: "error", synthetic_reason: "stale-slot-reconciled", child_disposition: "execution_unknown" })));
    expect(summary.syntheticInvocations).toHaveLength(2);
    expect(summary.syntheticInvocations[0].presentation).toBe("0 started + 0 not-started + 1 execution-unknown");
  });

  it("keeps productive terminals and publication manifests independent of status", () => {
    const summary = summarizeWorkerEvidence([{ status: "degraded", productive: 1, publication_count: 2 }, { status: "ok", productive: 0, publication_count: 0 }], { dex: [{ state: "published" }, { state: "failed" }] });
    expect(summary.productive).toBe(1);
    expect(summary.publicationCount).toBe(2);
    expect(summary.publicationStates.dex).toEqual({ published: 1, failed: 1 });
  });
});

describe("21-day incident evidence", () => {
  it("bounds daily shards and names missing history rather than inventing zero incidents", () => {
    const end = 30 * DAY;
    const day = (from: number) => ({ schemaVersion: 1, from, to: from + DAY, sources: {} });
    const bundle = assembleIncidentBundle([day(0), day(28 * DAY), day(29 * DAY)], end);
    expect(bundle.days).toHaveLength(2);
    expect(bundle.from).toBe(9 * DAY);
    expect(bundle.missingDays).toHaveLength(19);
    expect(bundle.coverage).toBe("partial");
    expect(bundle.reasons).toContain("daily-artifact-history-missing");
  });

  it("joins only singleton invocation/version evidence and retains duplicate delivery uncertainty", () => {
    const delivery = { scriptName: "stablecoin-api", cron: "0 * * * *", scheduledDatetime: "2026-10-18T00:00:00Z" };
    const child = { job: "job", schedule_key: "lane", slot_started_at: Date.parse(delivery.scheduledDatetime) / 1000, invocation_id: "invocation", worker_version: "version", output_published_at: 100 };
    const deployment = { scriptName: delivery.scriptName, id: "deploy", versions: [{ id: "version" }] };
    const definitions = { lane: { schedule: delivery.cron } };
    const joined = joinIncidentEvidence([delivery], [child], [deployment], [{ published_at: 100 }], definitions);
    expect(joined[0].join).toBe("singleton-version-match");
    expect(joined[0].publications[0].correlation).toBe("timestamp-only-not-causal-proof");
    expect(joinIncidentEvidence([delivery, delivery], [child], [deployment], [], definitions)[0].children).toEqual([]);
  });

  it.each([
    { invocation_id: null }, { invocation_id: undefined }, { invocation_id: "" }, { invocation_id: " " },
    { worker_version: null }, { worker_version: undefined }, { worker_version: "" }, { worker_version: " " },
    { invocation_id: "other-invocation" }, { worker_version: "other-version" },
  ])("leaves the whole delivery unattributed when a child has incomplete or mixed identity %j", (unknownIdentity) => {
    const delivery = { scriptName: "stablecoin-api", cron: "0 * * * *", scheduledDatetime: "2026-10-18T00:00:00Z" };
    const child = { job: "first", schedule_key: "lane", slot_started_at: Date.parse(delivery.scheduledDatetime) / 1000,
      invocation_id: "invocation", worker_version: "version", output_published_at: 100 };
    const children = [child, { ...child, job: "second", ...unknownIdentity }];
    const deployment = { scriptName: delivery.scriptName, id: "deploy", versions: [{ id: "version" }] };
    const joined = joinIncidentEvidence([delivery], children, [deployment], [{ published_at: 100 }], { lane: { schedule: delivery.cron } });
    expect(joined[0]).toMatchObject({
      join: "unattributed", reason: "missing-or-ambiguous-identity",
      deployment: null, invocationId: null, children: [], publications: [],
    });
  });

  it("joins multiple fully identified children of one invocation and exact deployment version", () => {
    const delivery = { scriptName: "stablecoin-api", cron: "0 * * * *", scheduledDatetime: "2026-10-18T00:00:00Z" };
    const children = ["first", "second"].map((job) => ({
      job, schedule_key: "lane", slot_started_at: Date.parse(delivery.scheduledDatetime) / 1000,
      invocation_id: "invocation", worker_version: "version", output_published_at: 100,
    }));
    const deployment = { scriptName: delivery.scriptName, id: "deploy", versions: [{ id: "version" }] };
    const joined = joinIncidentEvidence([delivery], children, [deployment], [{ published_at: 100 }], { lane: { schedule: delivery.cron } });
    expect(joined[0]).toMatchObject({ join: "singleton-version-match", invocationId: "invocation", deployment: "deploy", children });
    expect(joined[0].publications).toEqual([{ published_at: 100, correlation: "timestamp-only-not-causal-proof" }]);
    expect(joinIncidentEvidence([delivery], children, [{ ...deployment, versions: [{ id: "other-version" }] }], [],
      { lane: { schedule: delivery.cron } })[0].join).toBe("unattributed");
  });

  it("writes partial evidence after source failures without retaining error secrets or arbitrary metadata", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "worker-incidents-"));
    try {
      const query = vi.fn().mockImplementation((sql: string) => {
        expect(sql.trim()).toMatch(/^SELECT/i);
        if (sql.includes("FROM cron_runs")) return [{ job: "job", status: "error", error: "secret-error", metadata: "secret-metadata" }];
        throw new Error("secret-error");
      });
      const result = await captureWorkerIncidentBundle({ outDir, database: "db", remote: true }, {
        query, env: {}, now: new Date("2026-10-18T01:17:00Z"), deliveryReader: vi.fn().mockRejectedValue(new Error("secret-token")),
      });
      expect(result.collectionFailed).toBe(true);
      const text = readFileSync(join(outDir, "bundle.json"), "utf8");
      expect(text).not.toContain("secret-");
      expect(text).toContain("scheduled-invocations-unavailable");
      expect(JSON.parse(text).days[0].summary.counts.error).toBe(1);
      expect(JSON.parse(text).days[0].sources.children.rows).toEqual([
        expect.objectContaining({ job: "job", status: "error", invocation_id: null, worker_version: null }),
      ]);
    } finally { rmSync(outDir, { recursive: true, force: true }); }
  });
});

describe("read-only status profiling", () => {
  it("rejects mutation even through batch and preserves first() receipts", async () => {
    const receipts: object[] = [];
    const query = vi.fn().mockResolvedValue({ success: true, results: [{ count: 4 }], meta: { rows_read: 5, duration: 1 } });
    const db = createReadOnlyProfileDb(query, receipts);
    expect(() => db.prepare("UPDATE cache SET value = 'secret'")).toThrow("read-only");
    expect(() => db.prepare("WITH x AS (SELECT 1) DELETE FROM cache")).toThrow("read-only");
    expect(() => db.prepare("SELECT 1; DELETE FROM cache")).toThrow("read-only");
    expect(await db.prepare("SELECT '?' AS count WHERE id = ?").bind("safe").first("count")).toBe(4);
    expect(receipts).toEqual([{ rows_read: 5, duration: 1 }]);
    expect(query.mock.calls[0][1]).toEqual(["safe"]);
  });

  it("reports missing D1 metadata as unavailable, not zero measured cost", async () => {
    const result = await profileStatusRoute({
      query: async () => ({ results: [] }),
      handler: async ({ db }: { db: { prepare(sql: string): { all(): Promise<unknown> } } }) => {
        await db.prepare("SELECT 1").all();
        return new Response(JSON.stringify({ sectionErrors: {} }));
      },
      trackerFactory: (db: unknown) => ({ db, snapshot: () => ({ queries: 1, reasons: [] }) }),
    });
    expect(result.rowsRead).toBeNull();
    expect(result.sqlDurationMs).toBeNull();
    expect(result.coverage).toBe("partial");
    expect(result.selfCheck.coverage).toBe("unavailable");
  });
});

describe("lane freshness draft", () => {
  it("lists every registered logical job exactly once and requires owner sign-off", () => {
    const doc = readFileSync("docs/process/lane-freshness-matrix.md", "utf8");
    const names = [...doc.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
    expect(names).toHaveLength(CRON_JOB_DEFINITIONS.length);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(CRON_JOB_DEFINITIONS.map((job) => job.job).sort());
    expect(doc).toContain("Draft for owner sign-off");
  });
});
