#!/usr/bin/env node

import { appendFileSync, readFileSync } from "node:fs";

import {
  CliUsageError,
  assertCliUsage,
  parseCliInteger,
  parseStrictCliArgs,
  requireCliString,
  runDirectCli,
  writeFileResolved,
  writeJsonOutput,
} from "../lib/cli-args.mjs";
import {
  POST_DEPLOY_DATA_ENDPOINTS,
  POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
  POST_DEPLOY_DATA_REGRESSION_WAIT_SEC,
  buildPostDeployDataSnapshot,
  comparePostDeployDataSnapshots,
  formatPostDeployDataRegressionMarkdown,
  parsePostDeployDataSnapshot,
  type PostDeployDataEndpointResult,
  type PostDeployDataEndpointDefinition,
  type PostDeployDataRegressionReport,
} from "../lib/post-deploy-data-regression.mts";
import { fetchJsonProbe } from "../lib/worker-http-probes.mts";

/** Public API origin only; the CI key is never sent to an override URL. */
export const POST_DEPLOY_DATA_API_URL = "https://api.pharos.watch";
const CAPTURE_CONCURRENCY = 3;
const CAPTURE_TIMEOUT_MS = 20_000;

const USAGE = `Usage:
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ci/check-post-deploy-data-regression.ts \\
    --capture <path> [--skip-reason <reason>]
  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/ci/check-post-deploy-data-regression.ts \\
    --compare <baseline.json> [--wait-seconds <n>] [--report <path>] [--issue-body <path>]

Environment: PHAROS_API_KEY (required unless --skip-reason is used).`;

async function collectEndpointResults(apiKey: string | undefined): Promise<PostDeployDataEndpointResult[]> {
  if (!apiKey) {
    console.log("::warning::PHAROS_API_KEY is unavailable; endpoint counts will be reported as unknown, not healthy.");
  }
  const results: PostDeployDataEndpointResult[] = new Array(POST_DEPLOY_DATA_ENDPOINTS.length);
  let nextIndex = 0;

  const probe = async (definition: PostDeployDataEndpointDefinition): Promise<PostDeployDataEndpointResult> => {
    if (!apiKey) {
      return {
        endpoint: definition.key,
        path: definition.path,
        producer: definition.producer,
        status: 0,
        ok: false,
        generation: null,
        error: "missing-api-key",
      };
    }
    const response = await fetchJsonProbe(
      { apiUrl: POST_DEPLOY_DATA_API_URL, apiKey, timeoutMs: CAPTURE_TIMEOUT_MS },
      definition.path,
    );
    return {
      endpoint: definition.key,
      path: definition.path,
      producer: definition.producer,
      status: response.status,
      ok: response.ok,
      generation: response.updatedAt ?? null,
      error: response.error ?? null,
      payload: response.payload,
    };
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      const definition = POST_DEPLOY_DATA_ENDPOINTS[index];
      if (definition === undefined) return;
      try {
        results[index] = await probe(definition);
      } catch (error) {
        results[index] = {
          endpoint: definition.key,
          path: definition.path,
          producer: definition.producer,
          status: 0,
          ok: false,
          generation: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CAPTURE_CONCURRENCY, POST_DEPLOY_DATA_ENDPOINTS.length) }, worker),
  );
  return results;
}

function writeSummary(markdown: string, env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
}

async function capture(args: {
  path: string;
  skipReason?: string;
  apiKey?: string;
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (args.skipReason) {
    const snapshot = buildPostDeployDataSnapshot([], now, { reason: args.skipReason });
    writeJsonOutput(args.path, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(JSON.stringify({ capturedAt: now, skipped: args.skipReason, output: args.path }));
    return;
  }
  const results = await collectEndpointResults(args.apiKey);
  const snapshot = buildPostDeployDataSnapshot(results, now);
  writeJsonOutput(args.path, `${JSON.stringify(snapshot, null, 2)}\n`);
  const unread = snapshot.metrics.filter((metric) => metric.value == null);
  console.log(JSON.stringify({
    capturedAt: now,
    output: args.path,
    metrics: snapshot.metrics.length,
    unavailableMetrics: unread.length,
    endpoints: snapshot.endpoints.map((endpoint) => ({
      endpoint: endpoint.endpoint,
      status: endpoint.status,
      generation: endpoint.generation,
      error: endpoint.error,
    })),
  }, null, 2));
}

function reportUnknownBaseline(reason: string, budgetSeconds: number): PostDeployDataRegressionReport {
  return {
    outcome: "unknown",
    reason,
    baselineCapturedAt: 0,
    currentCapturedAt: Math.floor(Date.now() / 1000),
    budgetSeconds,
    maxDropRatio: POST_DEPLOY_DATA_REGRESSION_MAX_DROP_RATIO,
    findings: [],
    endpoints: [],
    endpointFailures: [],
  };
}

async function compare(args: {
  baselinePath: string;
  waitSeconds: number;
  reportPath?: string;
  issueBodyPath?: string;
  apiKey?: string;
  env: NodeJS.ProcessEnv;
}): Promise<number> {
  let baseline: ReturnType<typeof parsePostDeployDataSnapshot>;
  try {
    baseline = parsePostDeployDataSnapshot(JSON.parse(readFileSync(args.baselinePath, "utf8")));
  } catch (error) {
    // A detector read failure is unknown, never a producer regression (R2).
    const report = reportUnknownBaseline(
      `baseline-unreadable:${error instanceof Error ? error.message : String(error)}`,
      args.waitSeconds,
    );
    console.log(JSON.stringify(report, null, 2));
    writeSummary(formatPostDeployDataRegressionMarkdown(report), args.env);
    if (args.reportPath) writeJsonOutput(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  if (baseline.skipped) {
    const report = comparePostDeployDataSnapshots(baseline, baseline, { budgetSeconds: args.waitSeconds });
    console.log(JSON.stringify(report, null, 2));
    if (args.reportPath) writeJsonOutput(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    writeSummary(formatPostDeployDataRegressionMarkdown(report), args.env);
    console.log(`Baseline skipped (${baseline.skipped.reason}); nothing to compare.`);
    return 0;
  }

  if (args.waitSeconds > 0) {
    console.log(`Waiting ${args.waitSeconds}s for the first full producer cycle before re-reading the data counts.`);
    await new Promise((resolve) => setTimeout(resolve, args.waitSeconds * 1_000));
  }

  const current = buildPostDeployDataSnapshot(await collectEndpointResults(args.apiKey), Math.floor(Date.now() / 1000));
  const report = comparePostDeployDataSnapshots(baseline, current, { budgetSeconds: args.waitSeconds });
  const markdown = formatPostDeployDataRegressionMarkdown(report);
  console.log(JSON.stringify(report, null, 2));
  writeSummary(markdown, args.env);
  if (args.reportPath) writeJsonOutput(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (args.issueBodyPath) {
    writeFileResolved(
      args.issueBodyPath,
      `${markdown}\nReason code: \`${report.reason}\`\nRunbook: docs/deployment-process.md#operational-acceptance\n`
      + "Do not reset producer leases, checkpoints or caches to obtain a green run.\n",
    );
  }
  return report.outcome === "failed" ? 1 : 0;
}

export async function runPostDeployDataRegressionCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      capture: { type: "string" },
      compare: { type: "string" },
      "skip-reason": { type: "string" },
      "wait-seconds": { type: "string" },
      report: { type: "string" },
      "issue-body": { type: "string" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const hasCapture = typeof values.capture === "string";
  const hasCompare = typeof values.compare === "string";
  assertCliUsage(hasCapture !== hasCompare, "Pass exactly one of --capture or --compare.");
  const apiKey = env.PHAROS_API_KEY?.trim() || undefined;
  if (hasCapture) {
    assertCliUsage(
      values.compare === undefined && values["wait-seconds"] === undefined && values.report === undefined
        && values["issue-body"] === undefined,
      "--capture accepts only --capture/--skip-reason.",
    );
    await capture({
      path: requireCliString(values.capture, "--capture path"),
      skipReason: typeof values["skip-reason"] === "string" ? requireCliString(values["skip-reason"], "--skip-reason") : undefined,
      apiKey,
    });
    return 0;
  }
  return compare({
    baselinePath: requireCliString(values.compare, "--compare path"),
    waitSeconds: values["wait-seconds"] === undefined
      ? POST_DEPLOY_DATA_REGRESSION_WAIT_SEC
      : parseCliInteger(values["wait-seconds"], { name: "--wait-seconds", min: 0, max: 6 * 60 * 60 }),
    reportPath: typeof values.report === "string" ? requireCliString(values.report, "--report path") : undefined,
    issueBodyPath: typeof values["issue-body"] === "string" ? requireCliString(values["issue-body"], "--issue-body path") : undefined,
    apiKey,
    env,
  });
}

runDirectCli(import.meta.url, async () => {
  try {
    process.exitCode = await runPostDeployDataRegressionCli(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error(`\n${USAGE}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  }
});
