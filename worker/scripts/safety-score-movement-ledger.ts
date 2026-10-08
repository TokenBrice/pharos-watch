#!/usr/bin/env tsx
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../../scripts/lib/cli-args.mjs";
import { createRemoteD1Client, sqlString } from "./lib/remote-d1";
import { buildSafetyScoreMovementLedger, renderSafetyScoreMovementMarkdown, type SafetyScoreMovementRow, type SafetyScoreMovementAttempt } from "./lib/safety-score-movement-ledger";

const PAGE_SIZE = 1_000;
const USAGE = "Usage: npx tsx worker/scripts/safety-score-movement-ledger.ts --from YYYY-MM-DD --to YYYY-MM-DD --output <prefix> [--database stablecoin-db]\nRead-only remote SELECTs. --to is exclusive; maximum 120 days. Writes <prefix>.md and <prefix>.json.\n";

export function runSafetyScoreMovementLedgerCli(argv: readonly string[]): void {
  const { values } = parseStrictCliArgs(argv, { options: {
    from: { type: "string" }, to: { type: "string" }, output: { type: "string" }, database: { type: "string" },
  } });
  if (values.help) { process.stdout.write(USAGE); return; }
  const date = (value: unknown, flag: string): number => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CliUsageError(`${flag} requires YYYY-MM-DD`);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new CliUsageError(`${flag} is not a valid UTC date`);
    return Math.floor(parsed.getTime() / 1000);
  };
  const from = date(values.from, "--from"), to = date(values.to, "--to");
  if (to <= from || to - from > 120 * 86_400) throw new CliUsageError("Date range must be positive and at most 120 days");
  if (typeof values.output !== "string" || values.output.length === 0) throw new CliUsageError("--output is required");
  const client = createRemoteD1Client(typeof values.database === "string" ? values.database : "stablecoin-db");
  // queryRaw lets us reject failed/malformed envelopes instead of mistaking them for empty evidence.
  const select = <T>(sql: string): T[] => {
    const result: unknown = JSON.parse(client.queryRaw(sql));
    if (!Array.isArray(result) || result.length !== 1) throw new Error("ledger-query-envelope-invalid");
    const envelope = result[0] as { success?: boolean; results?: T[] };
    if (envelope.success !== true || !Array.isArray(envelope.results)) throw new Error("ledger-query-failed");
    return envelope.results;
  };
  const rows: SafetyScoreMovementRow[] = [];
  let cursor = "";
  while (true) {
    const page = select<SafetyScoreMovementRow>(`SELECT * FROM safety_score_publication_journal
      WHERE published_at >= ${from} AND published_at < ${to} ${cursor}
      ORDER BY published_at, generation_id, stablecoin_id LIMIT ${PAGE_SIZE}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (published_at, generation_id, stablecoin_id) > (${last.published_at}, ${sqlString(last.generation_id)}, ${sqlString(last.stablecoin_id)})`;
  }
  const coins = [...new Set(rows.map((row) => row.stablecoin_id))];
  const baselines: SafetyScoreMovementRow[] = [];
  for (let offset = 0; offset < coins.length; offset += 100) {
    baselines.push(...select<SafetyScoreMovementRow>(`SELECT j.* FROM json_each(${sqlString(JSON.stringify(coins.slice(offset, offset + 100)))}) c
      JOIN safety_score_publication_journal j ON j.rowid = (SELECT p.rowid FROM safety_score_publication_journal p
        WHERE p.stablecoin_id = c.value AND p.published_at < ${from}
        ORDER BY p.published_at DESC, p.generation_id DESC LIMIT 1) LIMIT 100`));
  }
  const attempts = select<SafetyScoreMovementAttempt>(`SELECT attempt_id, generation_id, attempted_at, outcome, hold_reason_codes_json
    FROM safety_score_publication_attempts WHERE attempted_at < ${from} ORDER BY attempted_at DESC, attempt_id DESC LIMIT 1`);
  cursor = "";
  while (true) {
    const page = select<SafetyScoreMovementAttempt>(`SELECT attempt_id, generation_id, attempted_at, outcome, hold_reason_codes_json
      FROM safety_score_publication_attempts WHERE attempted_at >= ${from} AND attempted_at < ${to} ${cursor}
      ORDER BY attempted_at, attempt_id LIMIT ${PAGE_SIZE}`);
    attempts.push(...page);
    if (page.length < PAGE_SIZE) break;
    const last = page[page.length - 1]!;
    cursor = `AND (attempted_at, attempt_id) > (${last.attempted_at}, ${sqlString(last.attempt_id)})`;
  }
  attempts.push(...select<SafetyScoreMovementAttempt>(`SELECT attempt_id, generation_id, attempted_at, outcome, hold_reason_codes_json
    FROM safety_score_publication_attempts WHERE attempted_at >= ${to} ORDER BY attempted_at, attempt_id LIMIT 1`));
  const ledger = buildSafetyScoreMovementLedger([...baselines, ...rows], attempts, from, to);
  const report = { ...ledger, capturedAt: new Date().toISOString(), database: values.database ?? "stablecoin-db",
    availableChangedRows: rows.length, attemptCount: attempts.length,
    evidenceLimit: "Change-only compact observations, not full replay. Retention/missing journals can leave unobserved edges; a release label is not causal proof." };
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(`${values.output}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${values.output}.md`, renderSafetyScoreMovementMarkdown(ledger.movements, ledger.missingBaselineCoinIds));
  process.stdout.write(`${JSON.stringify({ movements: ledger.movements.length, missingBaselineCoins: ledger.missingBaselineCoinIds.length, output: values.output })}\n`);
}

runDirectCli(import.meta.url, () => runSafetyScoreMovementLedgerCli(process.argv.slice(2)));
