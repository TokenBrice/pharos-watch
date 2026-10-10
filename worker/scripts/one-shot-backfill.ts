#!/usr/bin/env tsx
import { CliUsageError, parseStrictCliArgs, runDirectCli } from "../../scripts/lib/cli-args.mjs";
import { createWorkerD1Client } from "./lib/remote-d1";
import { createBackfillDatabase } from "./lib/backfill-d1";
import { buildChainRpcs } from "../src/lib/chain-registry";
import { normalizeCgApiKey } from "../src/lib/coingecko";

const jobs = {
  "backfill-depegs": () => import("./backfills/backfill-depegs").then((module) => module.handleBackfillDepegsTrusted),
  "backfill-supply-history": () => import("./backfills/backfill-supply-history").then((module) => module.handleBackfillSupplyHistoryTrusted),
  "backfill-stability-index": () => import("./backfills/backfill-stability-index").then((module) => module.handleBackfillStabilityIndex),
  "audit-depeg-history": () => import("./backfills/audit-depeg-history").then((module) => module.handleAuditDepegHistoryTrusted),
  "backfill-cg-prices": () => import("./backfills/backfill-cg-prices").then((module) => module.handleBackfillCgPricesTrusted),
  "backfill-yield-history": () => import("./backfills/backfill-yield-history").then((module) => module.handleBackfillYieldHistory),
  "backfill-mint-burn-prices": () => import("./backfills/backfill-mint-burn-prices").then((module) => module.handleBackfillMintBurnPrices),
  "backfill-mint-burn": () => import("./backfills/backfill-mint-burn").then((module) => module.handleBackfillMintBurn),
  "backfill-tape": () => import("./backfills/backfill-tape").then((module) => module.handleBackfillTape),
  "reclassify-atomic-roundtrips": () => import("./backfills/reclassify-atomic-roundtrips").then((module) => module.handleReclassifyAtomicRoundtripsTrusted),
  "backfill-blacklist-current-balances": () => import("./backfills/backfill-blacklist-current-balances").then((module) => module.handleBackfillBlacklistCurrentBalances),
  "bootstrap-jltxx-reserves": () => import("./backfills/bootstrap-jltxx-reserves").then((module) => module.handleBootstrapJltxxReserves),
};
export const ONE_SHOT_BACKFILL_JOBS = Object.keys(jobs);
// These algorithms contain destructive swaps or fenced multi-row publication.
export const ATOMIC_IMPORT_BACKFILL_JOBS = [
  "backfill-depegs", "backfill-stability-index", "audit-depeg-history",
  "backfill-mint-burn", "backfill-mint-burn-prices", "reclassify-atomic-roundtrips",
  "bootstrap-jltxx-reserves", "backfill-blacklist-current-balances",
];
const USAGE = `Usage: npx tsx worker/scripts/one-shot-backfill.ts <job> [options]
Jobs: ${ONE_SHOT_BACKFILL_JOBS.join(", ")}
--query <URL-encoded parameters> preserves each job's existing parameter names/defaults.
--body-json <JSON> supplies the optional request body. --method GET|POST (default POST).
--idempotency-key <intent> supplies a run identity (required by staged capture and live price repair).
--execute acknowledges writes; otherwise an explicit dry-run=true or dryRun=true query is required.
--allow-atomic-import explicitly accepts temporary live D1 unavailability for atomic jobs.
--database <name> (default stablecoin-db), --local (default remote), -h/--help.
Credentials: Wrangler authentication plus COINGECKO_API_KEY, ALCHEMY_API_KEY, DRPC_API_KEY as needed.
Outputs the original job response body unchanged, followed by a newline. No HTTP route or automatic retry.
See docs/runbooks/one-shot-backfills.md before operating.
`;

type Dependencies = {
  client?: Parameters<typeof createBackfillDatabase>[0];
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
};

export async function runOneShotBackfillCli(argv: readonly string[], dependencies: Dependencies = {}): Promise<void> {
  const { values, positionals } = parseStrictCliArgs(argv, { allowPositionals: true, options: {
    query: { type: "string" }, "body-json": { type: "string" }, method: { type: "string" },
    "idempotency-key": { type: "string" }, execute: { type: "boolean" }, database: { type: "string" }, local: { type: "boolean" },
    "allow-atomic-import": { type: "boolean" },
  } });
  const write = dependencies.write ?? ((text: string) => { process.stdout.write(text); });
  if (values.help) { write(USAGE); return; }
  const job = positionals[0];
  if (positionals.length !== 1 || !Object.prototype.hasOwnProperty.call(jobs, job ?? "")) throw new CliUsageError("Exactly one known job is required");
  const method = values.method ?? "POST";
  if (method !== "POST" && !(job === "audit-depeg-history" && method === "GET")) throw new CliUsageError("Only audit-depeg-history supports GET; all jobs support POST");
  const url = new URL(`https://operator.invalid/jobs/${job}`);
  url.search = typeof values.query === "string" ? values.query : "";
  const previewJobs = ["backfill-depegs", "backfill-stability-index", "audit-depeg-history", "backfill-mint-burn-prices", "backfill-tape", "backfill-blacklist-current-balances"];
  const dryRun = previewJobs.includes(job!) && url.searchParams.get(job === "backfill-blacklist-current-balances" ? "dryRun" : "dry-run") === "true";
  if (!values.execute && !dryRun) throw new CliUsageError("Supply --execute or a supported explicit preview query; this job may not implement dry-run");
  const needsAtomicImport = ATOMIC_IMPORT_BACKFILL_JOBS.includes(job!);
  if (!dryRun && needsAtomicImport && !values["allow-atomic-import"]) {
    throw new CliUsageError("This job requires --allow-atomic-import; D1 imports may interrupt live database availability");
  }
  if (values["allow-atomic-import"] && (!needsAtomicImport || dryRun)) {
    throw new CliUsageError("--allow-atomic-import is only supported for write-enabled atomic jobs");
  }
  if (job === "bootstrap-jltxx-reserves" && (url.search || values["body-json"] !== undefined || !values["idempotency-key"])) {
    throw new CliUsageError("Staged capture requires --idempotency-key and accepts no query/body overrides");
  }
  const request = new Request(url, { method, headers: {
    ...(values["idempotency-key"] ? { "Idempotency-Key": String(values["idempotency-key"]) } : {}),
    ...(values["body-json"] ? { "Content-Type": "application/json" } : {}),
  }, ...(values["body-json"] !== undefined ? { body: String(values["body-json"]) } : {}) });
  const env = dependencies.env ?? process.env;
  const client = dependencies.client ?? createWorkerD1Client(typeof values.database === "string" ? values.database : "stablecoin-db", values.local === true ? "local" : "remote");
  const handler = await jobs[job as keyof typeof jobs]();
  const uncertainReceipts: string[] = [];
  const response = await handler({ db: createBackfillDatabase(client, {
    atomicImports: needsAtomicImport && !dryRun,
    onUncertainAtomicOutcome: (receipt) => uncertainReceipts.push(receipt),
  }), url, request, trustedAdmin: true,
    coingeckoApiKey: normalizeCgApiKey(env.COINGECKO_API_KEY), alchemyApiKey: env.ALCHEMY_API_KEY ?? null,
    chainRpcs: buildChainRpcs(env.ALCHEMY_API_KEY, env.DRPC_API_KEY),
  });
  write(`${await response.text()}\n`);
  if (uncertainReceipts.length) {
    throw new Error(`Atomic outcome unknown; do not retry or trust rollback claims in the job body. Reconcile receipts: ${uncertainReceipts.join(", ")}`);
  }
  if (!response.ok) throw new Error(`${job} failed with status ${response.status}`);
}

runDirectCli(import.meta.url, () => runOneShotBackfillCli(process.argv.slice(2)));
