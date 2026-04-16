#!/usr/bin/env npx tsx
/**
 * Replay the most recent production digests through the NEW system prompt
 * and the NEW Opus 4.7 + max-effort request body, so the voice review can
 * diff new output against the old production copy before merging.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx agents/scripts/replay-digest-prompt.ts [--count 3]
 *
 * What it does:
 *   1. Pulls the most recent N non-weekly `daily_digest` rows from prod D1
 *      via `wrangler d1 execute stablecoin-db --remote --json`.
 *   2. For each row: parses `input_data`, calls `buildUserPrompt(data, [])`,
 *      and posts to the Anthropic Messages API using the same body shape
 *      `worker/src/cron/digest/platform.ts` sends in production
 *      (model=claude-opus-4-7, thinking.type=adaptive, output_config.effort=max).
 *   3. Prints each response JSON to stdout with the row's generated_at date
 *      and the old production copy inline for side-by-side comparison.
 *
 * This is an operator tool, not production code. It runs off-cycle and has
 * no impact on the live digest pipeline.
 */
import { execFileSync } from "node:child_process";
import type { DigestInputData } from "../../shared/types/digest";
// NOTE: imports below use the tsconfig.scripts.json path alias shape; run via tsx
import { buildUserPrompt, SYSTEM_PROMPT } from "../../worker/src/cron/daily-digest/prompt";

interface DigestRow {
  generated_at: number;
  digest_title: string | null;
  digest_text: string;
  digest_extended: string | null;
  input_data: string;
}

function parseArgs(argv: string[]): { count: number } {
  let count = 3;
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--count" || argv[i] === "-n") && argv[i + 1] != null) {
      count = parseInt(argv[i + 1]!, 10);
      i++;
    }
  }
  if (!Number.isFinite(count) || count < 1 || count > 10) {
    throw new Error(`--count must be 1..10 (got ${count})`);
  }
  return { count };
}

function fetchRecentDigests(count: number): DigestRow[] {
  const sql = `SELECT generated_at, digest_title, digest_text, digest_extended, input_data
               FROM daily_digest
               WHERE digest_meta IS NULL
                  OR json_extract(digest_meta, '$.type') IS NULL
                  OR json_extract(digest_meta, '$.type') != 'weekly'
               ORDER BY generated_at DESC
               LIMIT ${count}`;
  const out = execFileSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "stablecoin-db", "--remote", "--command", sql, "--json"],
    { cwd: `${process.cwd()}/worker`, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(out) as Array<{ results: DigestRow[] }>;
  return parsed[0]?.results ?? [];
}

async function callClaude(apiKey: string, systemPrompt: string, userPrompt: string): Promise<unknown> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required");
    process.exit(1);
  }
  const { count } = parseArgs(process.argv.slice(2));
  const rows = fetchRecentDigests(count);
  if (rows.length === 0) {
    console.error("No digest rows returned from production D1");
    process.exit(1);
  }
  for (const row of rows) {
    const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);
    const inputData = JSON.parse(row.input_data) as DigestInputData;
    const userPrompt = buildUserPrompt(inputData, []);
    console.log(`\n\n=== ${date} ===`);
    console.log("--- OLD PRODUCTION COPY ---");
    console.log(`title:    ${row.digest_title ?? "(null)"}`);
    console.log(`text:     ${row.digest_text}`);
    console.log(`extended: ${row.digest_extended ?? "(null)"}`);
    console.log("--- NEW REPLAY (Opus 4.7, max effort) ---");
    try {
      const result = await callClaude(apiKey, SYSTEM_PROMPT, userPrompt);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(`Replay failed for ${date}:`, err);
    }
  }
}

void main();
