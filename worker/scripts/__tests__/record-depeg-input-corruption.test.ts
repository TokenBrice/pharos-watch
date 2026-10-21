import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInputCorruptionPlan, main, parseInputCorruptionArgs } from "../record-depeg-input-corruption";
import { createRemoteD1Client } from "../lib/remote-d1";
import type * as RemoteD1Module from "../lib/remote-d1";
import { loadPredictionErrata } from "../../src/lib/depeg-resolver-errata-store";
import { rowToDepegEvent } from "../../src/lib/depeg-helpers";
import type { DepegRow } from "../../src/lib/depeg-helpers";
import { sealPredictionFixture, withSqliteD1 } from "../../src/lib/__tests__/depeg-resolver-ddrv2-store.test-support";

vi.mock("../lib/remote-d1", async (original) => ({
  ...await original<typeof RemoteD1Module>(),
  createRemoteD1Client: vi.fn(() => { throw new Error("Remote D1 must not be contacted in this suite"); }),
}));

afterEach(() => vi.restoreAllMocks());

const base = {
  eventId: 1, publicPredictionId: 1, stablecoinId: "lusd-liquity", incidentKey: "ddr:test",
  evidencePath: "/reviewed/input-unit-evidence.json", evidenceSha256: "a".repeat(64),
  reviewedBy: "reviewer O'Brien", operatorNote: "Native quote was compared to USD reference; retain genuine episode",
  createdAt: Math.floor(Date.now() / 1000),
};
const cli = ["--event-id", "1", "--prediction-id", "1", "--stablecoin-id", "lusd-liquity", "--incident-key", "ddr:test", "--reviewed-evidence", base.evidencePath, "--reviewed-by", base.reviewedBy, "--note", base.operatorNote];

describe("sealed input-corruption operator", () => {
  it("defaults to offline dry run and requires explicit remote opt-in for apply", () => {
    expect(parseInputCorruptionArgs(cli)).toMatchObject({ apply: false, input: { eventId: 1 } });
    expect(() => parseInputCorruptionArgs([...cli, "--apply"])).toThrow("explicit --remote");
    expect(parseInputCorruptionArgs([...cli, "--apply", "--remote"]).apply).toBe(true);
    expect(() => parseInputCorruptionArgs(["--apply", "--remote"])).toThrow("--event-id is required");
    expect(() => parseInputCorruptionArgs([...cli, "--local"])).toThrow();
  });

  it.each(["--reviewed-evidence", "--reviewed-by", "--note"])("refuses missing %s", (flag) => {
    const args = [...cli];
    args.splice(args.indexOf(flag), 2);
    expect(() => parseInputCorruptionArgs(args)).toThrow(`${flag} is required`);
  });

  it("refuses invalid identities, timestamps and hashes before rendering SQL", () => {
    for (const input of [{ ...base, eventId: -1 }, { ...base, publicPredictionId: 1.5 }, { ...base, createdAt: 0 }, { ...base, evidenceSha256: "unreviewed" }, { ...base, operatorNote: " " }]) {
      expect(() => buildInputCorruptionPlan(input)).toThrow();
    }
  });

  it("prints exact SQL without creating any D1 client; refuses unreadable/empty evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "depeg-erratum-test-"));
    const path = join(dir, "evidence.json");
    const args = [...cli]; args[args.indexOf("--reviewed-evidence") + 1] = path;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(main(args)).rejects.toThrow();
      writeFileSync(path, "  ");
      await expect(main(args)).rejects.toThrow("nonempty");
      writeFileSync(path, '{"finding":"mixed units"}');
      await main(args);
      const output = JSON.parse(String(log.mock.calls[0][0]));
      expect(output).toMatchObject({ dryRun: true, verdict: "disputed", reason: "input_corruption" });
      expect(output.statements).toEqual(buildInputCorruptionPlan({ ...base, evidencePath: path, evidenceSha256: output.evidenceSha256, createdAt: output.createdAt }).statements);
      expect(createRemoteD1Client).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])("applies through actual sealed guards, existing provenance=%s", async (existing) => withSqliteD1(async (db) => {
    const { incident, prediction } = await sealPredictionFixture(db);
    db.sqlite.exec("UPDATE depeg_events SET ended_at=200000 WHERE id=1");
    if (existing) db.sqlite.exec(`INSERT INTO depeg_event_provenance(event_id,source_kind,audit_verdict,public_json,created_at,updated_at) VALUES (1,'live','confirmed','{"auditVerdict":"confirmed","confidenceTier":"high","sourcePriceProviders":["original"]}',100,101)`);
    const rawBefore = db.sqlite.prepare("SELECT * FROM depeg_events WHERE id=1").get();
    const sealedBefore = db.sqlite.prepare("SELECT * FROM depeg_resolver_public_predictions").all();
    const assessmentsBefore = db.sqlite.prepare("SELECT * FROM depeg_resolver_assessments").all();
    const plan = buildInputCorruptionPlan({ ...base, incidentKey: incident.incidentKey, publicPredictionId: prediction.id });
    db.sqlite.exec(`BEGIN;\n${plan.statements.join("\n")}\nCOMMIT;`);
    expect(db.sqlite.prepare("SELECT * FROM depeg_events WHERE id=1").get()).toEqual(rawBefore);
    expect(db.sqlite.prepare("SELECT * FROM depeg_resolver_public_predictions").all()).toEqual(sealedBefore);
    expect(db.sqlite.prepare("SELECT * FROM depeg_resolver_assessments").all()).toEqual(assessmentsBefore);
    const readback = db.sqlite.prepare(plan.readbackSql).get();
    expect(readback).toMatchObject({ public_prediction_id: prediction.id, row_hash: prediction.rowHash, row_hash_before: prediction.rowHash, audit_verdict: "disputed", public_audit_verdict: "disputed" });
    expect(await loadPredictionErrata(db, { eventIds: [1] })).toMatchObject([{ reason: "input_corruption", state: "invalidated", replacementAssessmentId: null, rowHashBefore: prediction.rowHash }]);
    const row = await db.prepare("SELECT * FROM depeg_events_with_provenance WHERE id=1").first<DepegRow>();
    if (!row) throw new Error("Repaired event missing");
    const event = rowToDepegEvent(row);
    expect(event.provenance?.auditVerdict).toBe("disputed");
    if (existing) {
      expect(event.provenance).toMatchObject({ confidenceTier: "high", sourcePriceProviders: ["original"] });
      const audit = db.sqlite.prepare("SELECT details_json FROM admin_action_audit ORDER BY id LIMIT 1").get();
      expect(JSON.parse(String(audit?.details_json))).toMatchObject({ auditVerdictBefore: "confirmed", updatedAtBefore: 101 });
    }
    expect(() => db.sqlite.exec(plan.statements.join("\n"))).toThrow(/CHECK/);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM depeg_resolver_prediction_errata").get()?.n).toBe(1);
  }));

  it.each(["wrong coin", "wrong prediction", "wrong incident", "unsealed", "open", "expired plan", "already disputed", "existing erratum", "unused grant", "invalid public JSON"])("refuses %s atomically", async (failure) => withSqliteD1(async (db) => {
    const { incident, prediction } = await sealPredictionFixture(db);
    db.sqlite.exec("UPDATE depeg_events SET ended_at=200000 WHERE id=1");
    const input = { ...base, incidentKey: incident.incidentKey, publicPredictionId: prediction.id };
    if (failure === "wrong coin") input.stablecoinId = "another-coin";
    if (failure === "wrong prediction") input.publicPredictionId = 999;
    if (failure === "wrong incident") input.incidentKey = "ddr:unrelated";
    if (failure === "unsealed") { input.eventId = 999; db.sqlite.exec("INSERT INTO depeg_events(id,stablecoin_id,symbol,peg_type,direction,peak_deviation_bps,started_at,ended_at,start_price,peg_reference) VALUES (999,'lusd-liquity','LUSD','peggedUSD','below',-300,100,200,0.97,1)"); }
    if (failure === "open") db.sqlite.exec("UPDATE depeg_events SET ended_at=NULL WHERE id=1");
    if (failure === "expired plan") input.createdAt -= 1000;
    if (failure === "already disputed") db.sqlite.exec(`INSERT INTO depeg_event_provenance(event_id,source_kind,audit_verdict,public_json,created_at,updated_at) VALUES (1,'live','confirmed','{"auditVerdict":"disputed"}',100,101)`);
    if (failure === "existing erratum") db.sqlite.prepare("INSERT INTO depeg_resolver_prediction_errata(public_prediction_id,incident_key,event_id,assessment_id,reason,operator_note,created_at,created_by) VALUES (?,?,1,?,'input_corruption','prior review',100,'reviewer')").run(prediction.id, incident.incidentKey, prediction.assessmentId);
    if (failure === "unused grant") db.sqlite.prepare("INSERT INTO depeg_resolver_event_repair_authorizations(event_id,incident_key,operation,columns_json,reason,created_at,expires_at,created_by) VALUES (1,?,'identity_update','[]','prior grant',100,4102444800,'reviewer')").run(incident.incidentKey);
    if (failure === "invalid public JSON") db.sqlite.exec("INSERT INTO depeg_event_provenance(event_id,source_kind,public_json,created_at,updated_at) VALUES (1,'live','broken',100,101)");
    const before = db.sqlite.prepare("SELECT COUNT(*) AS n FROM depeg_resolver_prediction_errata").get()?.n;
    const plan = buildInputCorruptionPlan(input);
    db.sqlite.exec("BEGIN");
    try { expect(() => db.sqlite.exec(plan.statements.join("\n"))).toThrow(/CHECK/); }
    finally { db.sqlite.exec("ROLLBACK"); }
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM depeg_resolver_prediction_errata").get()?.n).toBe(before);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM admin_action_audit").get()?.n).toBe(0);
  }));
});
