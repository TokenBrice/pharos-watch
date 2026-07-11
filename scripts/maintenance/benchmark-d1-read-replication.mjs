#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_CASES = [
  "stablecoins-cache",
  "status-cron-window",
  "blacklist-page",
  "depeg-page",
  "tape-page",
];

function usage() {
  console.log(`Usage: node scripts/maintenance/benchmark-d1-read-replication.mjs --url <experiment-url> [options]

Read-only paired benchmark for the isolated D1 Sessions API experiment Worker.
This command never enables replication, deploys a Worker, or mutates D1.

Options:
  --url <url>          Experiment Worker origin (required)
  --case <name>        Query case; repeatable (defaults to all representative cases)
  --samples <n>        Measured primary/replica pairs per case (default: 30)
  --warmups <n>        Warm-up pairs per case (default: 3)
  --output <path>      JSON report path (default: agents/d1-read-replication-<timestamp>.json)
  --help               Show this help

Set D1_BENCHMARK_TOKEN to the experiment Worker's BENCHMARK_TOKEN secret.
`);
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv) {
  const options = { url: null, cases: [], samples: 30, warmups: 3, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--url") options.url = readValue(argv, ++index, arg);
    else if (arg === "--case") options.cases.push(readValue(argv, ++index, arg));
    else if (arg === "--samples") options.samples = positiveInteger(readValue(argv, ++index, arg), arg);
    else if (arg === "--warmups") options.warmups = nonNegativeInteger(readValue(argv, ++index, arg), arg);
    else if (arg === "--output") options.output = readValue(argv, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.url) throw new Error("--url is required");
  options.url = new URL(options.url).origin;
  options.cases = options.cases.length > 0 ? [...new Set(options.cases)] : DEFAULT_CASES;
  return options;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return Math.round(sorted[index] * 1000) / 1000;
}

function summarize(samples) {
  const wall = samples.map((sample) => sample.wallMs);
  const worker = samples.map((sample) => sample.body.elapsedMs).filter(Number.isFinite);
  return {
    sampleCount: samples.length,
    wallMs: { p50: percentile(wall, 50), p95: percentile(wall, 95) },
    workerMs: { p50: percentile(worker, 50), p95: percentile(worker, 95) },
    servedByPrimaryCount: samples.filter((sample) => sample.body.d1?.servedByPrimary === true).length,
    servedByReplicaCount: samples.filter((sample) => sample.body.d1?.servedByPrimary === false).length,
    regions: [...new Set(samples.map((sample) => sample.body.d1?.servedByRegion).filter(Boolean))],
    colos: [...new Set(samples.map((sample) => sample.body.d1?.servedByColo).filter(Boolean))],
  };
}

async function runSample(baseUrl, token, mode, benchmarkCase, asOf, iteration) {
  const url = new URL(baseUrl);
  url.searchParams.set("mode", mode);
  url.searchParams.set("case", benchmarkCase);
  url.searchParams.set("asOf", String(asOf));
  url.searchParams.set("sample", String(iteration));
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}`, "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
  const wallMs = performance.now() - startedAt;
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.mode !== mode || body.case !== benchmarkCase) {
    throw new Error(`${benchmarkCase}/${mode} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { wallMs: Math.round(wallMs * 1000) / 1000, body };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = (process.env.D1_BENCHMARK_TOKEN ?? "").trim();
  if (!token) throw new Error("D1_BENCHMARK_TOKEN is required");
  const generatedAt = new Date().toISOString();
  const asOf = Math.floor(Date.now() / 1000);
  const caseReports = [];

  for (const benchmarkCase of options.cases) {
    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      await runSample(options.url, token, "primary", benchmarkCase, asOf, `warmup-${warmup}-p`);
      await runSample(options.url, token, "replica", benchmarkCase, asOf, `warmup-${warmup}-r`);
    }

    const primary = [];
    const replica = [];
    let matchingPayloadPairs = 0;
    for (let sample = 0; sample < options.samples; sample += 1) {
      const modes = sample % 2 === 0 ? ["primary", "replica"] : ["replica", "primary"];
      const pair = {};
      for (const mode of modes) {
        pair[mode] = await runSample(options.url, token, mode, benchmarkCase, asOf, sample);
      }
      primary.push(pair.primary);
      replica.push(pair.replica);
      if (pair.primary.body.payloadHash === pair.replica.body.payloadHash) matchingPayloadPairs += 1;
    }
    const primarySummary = summarize(primary);
    const replicaSummary = summarize(replica);
    caseReports.push({
      case: benchmarkCase,
      matchingPayloadPairs,
      payloadPairCount: options.samples,
      primary: primarySummary,
      replica: replicaSummary,
      p95WallDeltaMs: primarySummary.wallMs.p95 == null || replicaSummary.wallMs.p95 == null
        ? null
        : Math.round((primarySummary.wallMs.p95 - replicaSummary.wallMs.p95) * 1000) / 1000,
    });
  }

  const report = {
    generatedAt,
    experimentUrl: options.url,
    asOf,
    samplesPerMode: options.samples,
    warmupsPerMode: options.warmups,
    cases: caseReports,
  };
  const output = options.output
    ?? path.join("agents", `d1-read-replication-${generatedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[d1-read-replication] wrote ${output}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
