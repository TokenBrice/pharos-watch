import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { runCliEntrypoint } from "../../scripts/lib/cli-args.mjs";
import { tronBase58ToHex } from "../src/lib/tron-address";
import { getBlacklistDerivedCacheKeys } from "../src/lib/blacklist-cache-keys";
import { parseDestructiveOperationArgs } from "./lib/destructive-operation-guard";
import { createRemoteD1Client, sqlString } from "./lib/remote-d1";

const SCRIPT = "repair-tron-blacklist-amounts";
const TOKEN = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TOKEN_HEX = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
const FREEZE_TOPIC = "42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc";
const integer = z.number().int().nonnegative().safe();
const hex = z.string().regex(/^[0-9a-f]{64}$/i);
const block = z.object({ blockID: hex, block_header: z.object({ raw_data: z.object({ number: integer, timestamp: integer }) }) });
const event = z.object({ id: z.string(), address: z.string().regex(/^0x[0-9a-f]{40}$/), base58: z.string(), tx_hash: hex, block_number: integer, timestamp: integer, configKey: z.string().min(1) });
const receipt = z.object({ id: hex, blockNumber: integer, blockTimeStamp: integer, receipt: z.object({ result: z.literal("SUCCESS") }), log: z.array(z.object({ address: z.string(), topics: z.array(z.string()) })) });
const transfer = z.object({ transaction_id: hex, token_info: z.object({ address: z.literal(TOKEN), decimals: z.literal(6) }), block_timestamp: integer, from: z.string(), to: z.string(), type: z.string(), value: z.string().regex(/^\d+$/) });
const schema = z.object({
  version: z.literal(1), provider: z.literal("https://api.trongrid.io"), capturedAtMs: integer,
  entries: z.array(z.object({
    event,
    anchor: z.object({
      before: block, after: block, observedAtMs: integer,
      balance: z.object({
        request: z.object({ owner_address: z.string().regex(/^41[0-9a-f]{40}$/), contract_address: z.literal(`41${TOKEN_HEX}`), function_selector: z.literal("balanceOf(address)"), parameter: hex, visible: z.literal(false) }),
        response: z.object({ result: z.object({ result: z.literal(true) }), constant_result: z.tuple([z.string().regex(/^[0-9a-f]{64}$/i)]) }),
      }),
    }),
    freezeReceipt: receipt,
    history: z.object({ initialUrl: z.string(), complete: z.literal(true), pages: z.array(z.object({ requestUrl: z.string(), response: z.object({ success: z.literal(true), data: z.array(transfer), meta: z.object({ at: integer, links: z.object({ next: z.string().optional() }).optional() }) }) })).min(1).max(100) }),
  })).min(1).max(8),
});

export interface TronReplayRepair { event: z.infer<typeof event>; rawAmount: string; amount: number; evidenceObservedAt: number; }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Validates captured official responses; never turns incomplete evidence into a balance. */
export async function validateTronReplayEvidence(input: unknown, nowMs = Date.now()): Promise<TronReplayRepair[]> {
  const evidence = schema.parse(input);
  assert(nowMs >= evidence.capturedAtMs && nowMs - evidence.capturedAtMs <= 15 * 60_000, "Evidence is stale or future-dated");
  const ids = new Set<string>();
  const repairs: TronReplayRepair[] = [];
  for (const entry of evidence.entries) {
    const e = entry.event, anchor = entry.anchor;
    assert(!ids.has(e.id), "Duplicate event id"); ids.add(e.id);
    assert(e.configKey === `tron-${TOKEN.toLowerCase()}` && e.id.startsWith(`tron-${e.tx_hash}-`), "Unexpected event configuration");
    assert(await tronBase58ToHex(e.base58) === e.address, "Address encoding mismatch");
    assert(anchor.before.blockID === anchor.after.blockID && JSON.stringify(anchor.before.block_header) === JSON.stringify(anchor.after.block_header), "Balance anchor crossed a confirmed block");
    const cutoff = anchor.before.block_header.raw_data.timestamp;
    assert(anchor.before.block_header.raw_data.number > e.block_number && cutoff > e.timestamp * 1000, "Anchor must follow freeze");
    assert(anchor.observedAtMs >= cutoff && anchor.observedAtMs <= evidence.capturedAtMs && nowMs - anchor.observedAtMs <= 45 * 60_000, "Balance anchor outside bounded capture window");
    assert(anchor.balance.request.parameter === e.address.slice(2).padStart(64, "0") && anchor.balance.request.owner_address === `41${e.address.slice(2)}`, "Balance call address mismatch");
    const r = entry.freezeReceipt;
    assert(r.id === e.tx_hash && r.blockNumber === e.block_number && r.blockTimeStamp === e.timestamp * 1000, "Freeze receipt identity mismatch");
    const logIndex = r.log.findIndex((l) => l.address.toLowerCase() === TOKEN_HEX && l.topics[0]?.toLowerCase() === FREEZE_TOPIC && l.topics[1]?.toLowerCase() === e.address.slice(2).padStart(64, "0"));
    assert(logIndex >= 0 && r.log.filter((l) => l.address.toLowerCase() === TOKEN_HEX && l.topics[0]?.toLowerCase() === FREEZE_TOPIC && l.topics[1]?.toLowerCase() === e.address.slice(2).padStart(64, "0")).length === 1, "Freeze event not uniquely proved");
    // Tron event_index is provider-owned, so the DB event identity is checked separately;
    // do not assume it equals the receipt-wide log index.
    const initial = new URL(entry.history.initialUrl);
    assert(initial.origin === evidence.provider && initial.pathname === `/v1/accounts/${e.base58}/transactions/trc20`, "Untrusted history endpoint");
    const required = { min_timestamp: "0", max_timestamp: String(cutoff), only_confirmed: "true", contract_address: TOKEN, order_by: "block_timestamp,asc" };
    for (const [key, value] of Object.entries(required)) assert(initial.searchParams.get(key) === value, `Invalid history ${key}`);
    const allowed = new Set([...Object.keys(required), "limit", "fingerprint"]);
    assert(!initial.searchParams.has("fingerprint") && [...initial.searchParams.keys()].every((key) => allowed.has(key) && initial.searchParams.getAll(key).length === 1), "Unexpected history filters");
    let next: string | undefined = initial.href;
    let lastTimestamp = -1, net = 0n, postFreeze = 0n;
    const records = new Set<string>();
    for (const page of entry.history.pages) {
      assert(next === page.requestUrl, "Pagination chain mismatch");
      const url = new URL(page.requestUrl);
      assert(url.origin === initial.origin && url.pathname === initial.pathname, "Untrusted page URL");
      for (const [key, value] of initial.searchParams) assert(url.searchParams.get(key) === value && url.searchParams.getAll(key).length === 1, "Pagination changed query bounds");
      assert([...url.searchParams.keys()].every((key) => allowed.has(key)), "Unexpected pagination filters");
      assert(page.response.meta.at >= cutoff + 15 * 60_000 && page.response.meta.at <= evidence.capturedAtMs, "Indexer capture has insufficient runway");
      for (const t of page.response.data) {
        assert(t.block_timestamp >= lastTimestamp && t.block_timestamp <= cutoff, "Transfer order or cutoff invalid"); lastTimestamp = t.block_timestamp;
        assert(t.type === "Transfer" || t.type === "Approval", "Unsupported token history event");
        if (t.type === "Approval") continue;
        assert(t.from === e.base58 || t.to === e.base58, "Unrelated transfer");
        assert(t.block_timestamp !== e.timestamp * 1000, "Ambiguous same-timestamp transfer");
        const identity = JSON.stringify([t.transaction_id, t.block_timestamp, t.from, t.to, t.value]);
        assert(!records.has(identity), "Duplicate transfer record requires receipt-level review"); records.add(identity);
        const value = BigInt(t.value);
        const delta = (t.to === e.base58 ? value : 0n) - (t.from === e.base58 ? value : 0n);
        net += delta;
        assert(net >= 0n, "Incomplete history has a negative running balance");
        if (t.block_timestamp > e.timestamp * 1000) postFreeze += delta;
      }
      next = page.response.meta.links?.next;
    }
    assert(next == null, "Incomplete pagination");
    const current = BigInt(`0x${anchor.balance.response.constant_result[0]}`);
    assert(net === current, "History does not reconcile with raw confirmed balance");
    const rawAmount = current - postFreeze;
    assert(rawAmount > 0n && rawAmount <= BigInt(Number.MAX_SAFE_INTEGER), "Invalid or unrepresentable event balance");
    repairs.push({ event: e, rawAmount: rawAmount.toString(), amount: Number(rawAmount) / 1e6, evidenceObservedAt: Math.floor(evidence.capturedAtMs / 1000) });
  }
  return repairs;
}

function guard(repair: TronReplayRepair): string {
  const e = repair.event;
  return `(id=${sqlString(e.id)} AND chain_id='tron' AND stablecoin='USDT' AND event_type='blacklist' AND contract_address=${sqlString(TOKEN)} AND address=${sqlString(e.address)} AND tx_hash=${sqlString(e.tx_hash)} AND block_number=${e.block_number} AND timestamp=${e.timestamp} AND config_key=${sqlString(e.configKey)} AND amount_native IS NULL AND amount_usd_at_event IS NULL AND amount IS NULL AND amount_status IN ('recoverable_pending','provider_failed','ambiguous','permanently_unavailable') AND suppression_reason IS NULL)`;
}

export function buildTronReplayRepairSql(repairs: TronReplayRepair[], hash: string, bookmark: string, nowSec: number): string[] {
  assert(repairs.length > 0 && repairs.length <= 8 && /^[0-9a-f]{64}$/.test(hash), "Invalid repair plan");
  const where = repairs.map(guard).join(" OR ");
  const details = JSON.stringify({ evidenceSha256: hash, bookmark, events: repairs.map((r) => ({ id: r.event.id, rawAmount: r.rawAmount, evidenceObservedAt: r.evidenceObservedAt })) });
  const value = `CASE id ${repairs.map((r) => `WHEN ${sqlString(r.event.id)} THEN ${r.amount}`).join(" ")} END`;
  const observedAt = `CASE id ${repairs.map((r) => `WHEN ${sqlString(r.event.id)} THEN ${r.evidenceObservedAt}`).join(" ")} END`;
  // The audit CHECK deliberately aborts the single atomic D1 import if any row changed.
  return [
    `INSERT INTO admin_action_audit(created_at,actor,action,target,result,details_json,intent_key) SELECT ${nowSec},'operator-cli',${sqlString(SCRIPT)},'tron-USDT',CASE WHEN (SELECT COUNT(*) FROM blacklist_events WHERE ${where})=${repairs.length} THEN 'ok' ELSE 'guard_failed' END,${sqlString(details)},${sqlString(hash)};`,
    `UPDATE blacklist_events SET amount=${value},amount_native=${value},amount_usd_at_event=${value},amount_source='derived',amount_status='resolved',amount_last_error_class=NULL,amount_last_provider='trongrid-transfer-ledger',amount_last_attempted_at=${nowSec},amount_attempt_count=amount_attempt_count+1,provenance_source=${sqlString(`trongrid-transfer-replay:${hash}`)},provenance_observed_at=${observedAt} WHERE ${where};`,
    `DELETE FROM cache WHERE key IN (${getBlacklistDerivedCacheKeys().map(sqlString).join(",")});`,
  ];
}

export async function main(argv: string[]): Promise<void> {
  const { mode, values } = parseDestructiveOperationArgs({ argv, scriptName: SCRIPT, defaultTarget: "--remote", localAllowed: false, cliOptions: { evidence: { type: "string" } } });
  if (values.help) { console.log(`Usage: npx tsx worker/scripts/${SCRIPT}.ts --evidence <file> [--execute --confirm ${SCRIPT}]\nDefault is read-only dry-run. Live execution records a fresh Time Travel bookmark and applies one guarded atomic SQL import.`); return; }
  assert(typeof values.evidence === "string", "--evidence is required");
  const bytes = readFileSync(values.evidence, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const repairs = await validateTronReplayEvidence(JSON.parse(bytes));
  const db = createRemoteD1Client("stablecoin-db");
  const pending = db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM blacklist_events WHERE ${repairs.map(guard).join(" OR ")}`)[0]?.n;
  assert(pending === repairs.length, "One or more exact events are no longer unresolved; no mutations performed");
  console.log(JSON.stringify({ dryRun: mode.dryRun, evidenceSha256: hash, repairs }, null, 2));
  if (mode.dryRun) return;
  const bookmarkResult = JSON.parse(execFileSync("npx", ["wrangler", "d1", "time-travel", "info", "stablecoin-db", "--json"], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8", stdio: "pipe" }));
  const bookmark = bookmarkResult.bookmark;
  assert(typeof bookmark === "string" && bookmark.length > 0, "Fresh Time Travel bookmark unavailable");
  console.log(`Pre-repair bookmark: ${bookmark}`);
  // Recheck freshness immediately before the atomic import; do not recapture or alter evidence.
  await validateTronReplayEvidence(JSON.parse(bytes));
  db.executeStatements(buildTronReplayRepairSql(repairs, hash, bookmark, Math.floor(Date.now() / 1000)), SCRIPT);
  const changed = db.query<{ id: string; amount_native: number }>(`SELECT id,amount_native FROM blacklist_events WHERE provenance_source=${sqlString(`trongrid-transfer-replay:${hash}`)} AND amount_status='resolved'`);
  assert(changed.length === repairs.length && repairs.every((r) => changed.some((c) => c.id === r.event.id && c.amount_native === r.amount)), "Repair readback failed; inspect audit and bookmark");
  console.log(`Verified ${changed.length} repaired event amounts; evidence ${hash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCliEntrypoint(() => main(process.argv.slice(2)));
