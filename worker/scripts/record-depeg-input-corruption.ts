import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runCliEntrypoint } from "../../scripts/lib/cli-args.mjs";
import { decodeD1Envelopes } from "../../scripts/lib/remote-d1";
import type { DdrRepairOperation } from "../src/lib/depeg-resolver-repair-store";
import { createRemoteD1Client, sqlString } from "./lib/remote-d1";

const SCRIPT = "record-depeg-input-corruption";
const OPERATION = "provenance_invalidation" satisfies DdrRepairOperation;
const positiveInteger = z.number().int().positive().safe();
const text = z.string().trim().min(1);
const inputSchema = z.object({
  eventId: positiveInteger,
  publicPredictionId: positiveInteger,
  stablecoinId: text,
  incidentKey: text,
  evidencePath: text,
  evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  reviewedBy: text,
  operatorNote: text,
  createdAt: positiveInteger,
});
export type InputCorruptionPlanInput = z.infer<typeof inputSchema>;

export function parseInputCorruptionArgs(argv: string[]) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    apply: { type: "boolean", default: false }, remote: { type: "boolean", default: false },
    help: { type: "boolean", default: false }, "event-id": { type: "string" },
    "prediction-id": { type: "string" }, "stablecoin-id": { type: "string" },
    "incident-key": { type: "string" }, "reviewed-evidence": { type: "string" },
    "reviewed-by": { type: "string" }, note: { type: "string" },
  } });
  if (values.apply && !values.remote) throw new Error("--apply requires explicit --remote");
  if (values.help) return { help: true as const, apply: false, input: null };
  const required = (key: keyof typeof values): string => {
    const value = values[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
    return value;
  };
  return { help: false as const, apply: values.apply, input: {
    eventId: positiveInteger.parse(Number(required("event-id"))),
    publicPredictionId: positiveInteger.parse(Number(required("prediction-id"))),
    stablecoinId: required("stablecoin-id"), incidentKey: required("incident-key"),
    evidencePath: required("reviewed-evidence"), reviewedBy: required("reviewed-by"),
    operatorNote: required("note"),
  } };
}

/** Offline plan: all live identity and single-use checks run inside one D1 import. */
export function buildInputCorruptionPlan(input: InputCorruptionPlanInput) {
  const p = inputSchema.parse(input);
  const event = p.eventId, prediction = p.publicPredictionId, incident = sqlString(p.incidentKey);
  const expiresAt = p.createdAt + 15 * 60;
  const note = JSON.stringify({ operation: SCRIPT, evidencePath: p.evidencePath,
    evidenceSha256: p.evidenceSha256, reviewedBy: p.reviewedBy, note: p.operatorNote });
  const noteSql = sqlString(note), actor = sqlString(p.reviewedBy);
  const predictionWhere = `p.id=${prediction} AND p.event_id=${event} AND p.incident_key=${incident}`;
  const erratumWhere = `er.public_prediction_id=${prediction} AND er.event_id=${event} AND er.incident_key=${incident} AND er.reason='input_corruption' AND er.operator_note=${noteSql} AND er.created_at=${p.createdAt}`;
  const authorizationWhere = `a.event_id=${event} AND a.incident_key=${incident} AND a.operation='${OPERATION}' AND a.created_at=${p.createdAt} AND a.expires_at=${expiresAt} AND a.created_by=${actor} AND a.required_erratum_id=(SELECT er.id FROM depeg_resolver_prediction_errata er WHERE ${erratumWhere})`;
  const guard = `
    unixepoch() BETWEEN ${p.createdAt} AND ${expiresAt}
    AND (SELECT COUNT(*) FROM depeg_events WHERE id=${event} AND stablecoin_id=${sqlString(p.stablecoinId)} AND ended_at IS NOT NULL)=1
    AND (SELECT COUNT(*) FROM depeg_resolver_public_predictions p WHERE ${predictionWhere} AND length(p.row_hash)=64)=1
    AND (SELECT COUNT(*) FROM depeg_resolver_public_predictions p JOIN depeg_resolver_incident_event_links l ON l.incident_key=p.incident_key WHERE l.event_id=${event})=1
    AND EXISTS (SELECT 1 FROM depeg_resolver_incident_event_links WHERE event_id=${event} AND incident_key=${incident})
    AND NOT EXISTS (SELECT 1 FROM depeg_resolver_prediction_errata WHERE public_prediction_id=${prediction})
    AND NOT EXISTS (SELECT 1 FROM depeg_event_provenance WHERE event_id=${event} AND (audit_verdict IN ('false_positive','disputed','no_data') OR (public_json IS NOT NULL AND CASE WHEN json_valid(public_json) THEN json_type(public_json)!='object' OR json_extract(public_json,'$.auditVerdict') IN ('false_positive','disputed','no_data') ELSE 1 END)))
    AND NOT EXISTS (SELECT 1 FROM depeg_resolver_event_repair_authorizations a WHERE a.event_id=${event} AND a.expires_at>=unixepoch() AND NOT EXISTS (SELECT 1 FROM depeg_resolver_event_repair_authorization_uses u WHERE u.authorization_id=a.id))`;
  // admin_action_audit.result has a CHECK ('ok','error'): 'guard_failed' aborts
  // the entire atomic import rather than leaving a partial append-only repair.
  const guardedAuditStatement = (phase: "before" | "after", condition: string, details: string) => `INSERT INTO admin_action_audit(created_at,actor,action,target,result,details_json,intent_key) VALUES (${p.createdAt},${actor},'${SCRIPT}',${sqlString(String(event))},CASE WHEN (${condition}) THEN 'ok' ELSE 'guard_failed' END,${details},${sqlString(`${p.evidenceSha256}:${event}:${phase}`)});`;
  const readbackSql = `SELECT er.id AS erratum_id,p.id AS public_prediction_id,p.row_hash,er.row_hash_before,a.id AS authorization_id,c.consumed_at,u.used_at,v.audit_verdict,json_extract(v.public_json,'$.auditVerdict') AS public_audit_verdict FROM depeg_resolver_prediction_errata er JOIN depeg_resolver_public_predictions p ON p.id=er.public_prediction_id JOIN depeg_resolver_event_repair_authorizations a ON a.required_erratum_id=er.id JOIN depeg_resolver_event_repair_authorization_consumptions c ON c.authorization_id=a.id JOIN depeg_resolver_event_repair_authorization_uses u ON u.authorization_id=a.id JOIN depeg_event_provenance v ON v.event_id=er.event_id WHERE ${erratumWhere};`;
  // SAFETY: numbers are schema-validated safe integers; every operator string is
  // sqlString-quoted. The shared remote client sends these in one unchunked import.
  const statements = [
    guardedAuditStatement("before", guard, `json_object('review',json(${noteSql}),'publicJsonBefore',(SELECT public_json FROM depeg_event_provenance WHERE event_id=${event}),'auditVerdictBefore',(SELECT audit_verdict FROM depeg_event_provenance WHERE event_id=${event}),'updatedAtBefore',(SELECT updated_at FROM depeg_event_provenance WHERE event_id=${event}))`),
    `INSERT INTO depeg_resolver_prediction_errata(public_prediction_id,incident_key,event_id,assessment_id,reason,operator_note,replacement_assessment_id,replacement_row_hash,row_hash_before,created_at,created_by) SELECT p.id,p.incident_key,p.event_id,p.assessment_id,'input_corruption',${noteSql},NULL,NULL,p.row_hash,${p.createdAt},${actor} FROM depeg_resolver_public_predictions p WHERE ${predictionWhere};`,
    `INSERT INTO depeg_resolver_event_repair_authorizations(event_id,incident_key,operation,columns_json,required_revision_id,required_erratum_id,reason,created_at,expires_at,created_by) SELECT ${event},${incident},'${OPERATION}','["audit_verdict","public_json","updated_at"]',NULL,er.id,${noteSql},${p.createdAt},${expiresAt},${actor} FROM depeg_resolver_prediction_errata er WHERE ${erratumWhere};`,
    `INSERT INTO depeg_resolver_event_repair_authorization_consumptions(authorization_id,event_id,incident_key,operation,consumed_at,consumer) SELECT a.id,a.event_id,a.incident_key,a.operation,${p.createdAt},${actor} FROM depeg_resolver_event_repair_authorizations a WHERE ${authorizationWhere} AND a.expires_at>=unixepoch();`,
    `INSERT INTO depeg_event_provenance(event_id,source_kind,audit_verdict,public_json,created_at,updated_at) SELECT id,source,'disputed','{"auditVerdict":"disputed"}',${p.createdAt},${p.createdAt} FROM depeg_events WHERE id=${event} ON CONFLICT(event_id) DO UPDATE SET audit_verdict='disputed',public_json=json_set(COALESCE(depeg_event_provenance.public_json,'{}'),'$.auditVerdict','disputed'),updated_at=${p.createdAt};`,
    guardedAuditStatement("after", `(SELECT COUNT(*) FROM (${readbackSql.slice(0, -1)}) WHERE audit_verdict='disputed' AND public_audit_verdict='disputed' AND row_hash=row_hash_before)=1`, noteSql),
  ];
  return { ...p, expiresAt, reason: "input_corruption" as const, verdict: "disputed" as const,
    preserves: ["depeg_events", "depeg_resolver_public_predictions", "depeg_resolver_assessments"],
    statements, readbackSql };
}

export async function main(argv: string[]): Promise<void> {
  const args = parseInputCorruptionArgs(argv);
  if (args.help) {
    console.log(`Usage: npx tsx worker/scripts/${SCRIPT}.ts --event-id <id> --prediction-id <id> --stablecoin-id <id> --incident-key <key> --reviewed-evidence <file> --reviewed-by <reviewer> --note <finding> [--apply --remote]\nDefault: offline DRY-RUN, prints exact guarded SQL. Apply performs one atomic remote import; no raw event or sealed prediction is rewritten.`);
    return;
  }
  const evidencePath = resolve(args.input.evidencePath);
  const bytes = readFileSync(evidencePath);
  if (!new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).trim()) throw new Error("Reviewed evidence must be nonempty UTF-8 text");
  const plan = buildInputCorruptionPlan({ ...args.input, evidencePath,
    evidenceSha256: createHash("sha256").update(bytes).digest("hex"), createdAt: Math.floor(Date.now() / 1000) });
  console.log(JSON.stringify({ dryRun: !args.apply, database: "stablecoin-db", ...plan }, null, 2));
  if (!args.apply) return;
  const db = createRemoteD1Client("stablecoin-db");
  if (!db.executeStatementsRaw) throw new Error("Unchunked atomic D1 import unavailable");
  // Never split the erratum, grant, consumption and invalidation across imports.
  decodeD1Envelopes(JSON.parse(db.executeStatementsRaw(plan.statements, SCRIPT)));
  const rows = db.query<{ row_hash: string; row_hash_before: string; audit_verdict: string; public_audit_verdict: string }>(plan.readbackSql);
  if (rows.length !== 1 || rows[0].row_hash !== rows[0].row_hash_before || rows[0].audit_verdict !== "disputed" || rows[0].public_audit_verdict !== "disputed") {
    throw new Error("Repair readback failed; reconcile append-only ledgers before any retry");
  }
  console.log(JSON.stringify({ applied: true, evidenceSha256: plan.evidenceSha256, readback: rows }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCliEntrypoint(() => main(process.argv.slice(2)));
