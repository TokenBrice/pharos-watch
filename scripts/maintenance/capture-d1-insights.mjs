#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_DATABASE = "stablecoin-db";
const DEFAULT_CONFIG = "worker/wrangler.toml";
const DEFAULT_LIMIT = 50;
const DEFAULT_CAPTURES = [
  { period: "7d", sortBy: "reads" },
  { period: "30d", sortBy: "reads" },
  { period: "30d", sortBy: "time" },
];
const SOURCE_ROOTS = ["worker/src", "worker/migrations", "functions", "shared/lib"];
const SQL_COMMENT_RE = /\/\*\s*([^*]+?)\s*\*\//g;

function printHelp() {
  console.log(`Usage: node scripts/maintenance/capture-d1-insights.mjs [options]

Read-only D1 insights capture helper. Defaults to the production database name
and captures 7d reads, 30d reads, and 30d time views.

Options:
  --database <name>     D1 database name (default: ${DEFAULT_DATABASE})
  --config <path>       Wrangler config (default: ${DEFAULT_CONFIG})
  --limit <n>           Queries returned per capture (default: ${DEFAULT_LIMIT})
  --period <value>      Capture period; repeatable, e.g. 7d or 30d
  --sort-by <value>     Sort key for all provided periods; repeatable
  --output <path>       Output JSON path (default: agents/d1-insights-<timestamp>.json)
  --dry-run             Print wrangler commands without running them
  --help                Show this help
`);
}

function parseArgs(argv) {
  const options = {
    database: DEFAULT_DATABASE,
    config: DEFAULT_CONFIG,
    limit: DEFAULT_LIMIT,
    periods: [],
    sortBy: [],
    output: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--database") {
      options.database = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--config") {
      options.config = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--limit") {
      const limit = Number(requireValue(argv, ++i, arg));
      if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit must be a positive integer");
      options.limit = limit;
      continue;
    }
    if (arg === "--period") {
      options.periods.push(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg === "--sort-by") {
      options.sortBy.push(requireValue(argv, ++i, arg));
      continue;
    }
    if (arg === "--output") {
      options.output = requireValue(argv, ++i, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function buildCaptureSpecs(options) {
  if (options.periods.length === 0 && options.sortBy.length === 0) return DEFAULT_CAPTURES;
  const periods = options.periods.length > 0 ? options.periods : ["30d"];
  const sorts = options.sortBy.length > 0 ? options.sortBy : ["reads"];
  return periods.flatMap((period) => sorts.map((sortBy) => ({ period, sortBy })));
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${stderr}`));
    });
  });
}

async function collectSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "out") continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|mjs|sql|md)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function buildSqlCommentIndex() {
  const index = new Map();
  const files = (await Promise.all(SOURCE_ROOTS.map(collectSourceFiles))).flat();
  await Promise.all(files.map(async (file) => {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const match of text.matchAll(SQL_COMMENT_RE)) {
      const comment = normalizeComment(match[1]);
      if (!comment) continue;
      const current = index.get(comment) ?? [];
      current.push(file);
      index.set(comment, current);
    }
  }));
  return index;
}

function normalizeComment(value) {
  return value.trim().replace(/\s+/g, " ");
}

function isDigit(value) {
  return value >= "0" && value <= "9";
}

function isWordChar(value) {
  return (
    (value >= "0" && value <= "9") ||
    (value >= "A" && value <= "Z") ||
    (value >= "a" && value <= "z") ||
    value === "_"
  );
}

function replaceNumericLiterals(sql) {
  let normalized = "";
  let index = 0;
  while (index < sql.length) {
    if (!isDigit(sql[index]) || isWordChar(sql[index - 1] ?? "")) {
      normalized += sql[index];
      index++;
      continue;
    }

    let end = index + 1;
    while (isDigit(sql[end] ?? "")) end++;
    if (sql[end] === "." && isDigit(sql[end + 1] ?? "")) {
      end++;
      while (isDigit(sql[end] ?? "")) end++;
    }

    if (!isWordChar(sql[end] ?? "")) {
      normalized += "?";
    } else {
      normalized += sql.slice(index, end);
    }
    index = end;
  }
  return normalized;
}

function normalizeSql(sql) {
  const withoutCommentsAndStrings = sql
    .replace(SQL_COMMENT_RE, " ")
    .replace(/'[^']*'/g, "?");
  return replaceNumericLiterals(withoutCommentsAndStrings)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fingerprintSql(sql) {
  return createHash("sha256").update(normalizeSql(sql)).digest("hex").slice(0, 16);
}

function findSql(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["query", "sql", "statement", "text"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && /\b(select|insert|update|delete|create|with)\b/i.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function annotateRows(payload, commentIndex) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.results)
        ? payload.results
        : Array.isArray(payload?.queries)
          ? payload.queries
          : [];
  return rows.map((row) => {
    const sql = findSql(row);
    if (!sql) return row;
    const commentMatch = [...sql.matchAll(SQL_COMMENT_RE)][0];
    const sqlComment = commentMatch ? normalizeComment(commentMatch[1]) : null;
    return {
      ...row,
      _pharos: {
        sqlFingerprint: fingerprintSql(sql),
        sqlComment,
        sourcePaths: sqlComment ? commentIndex.get(sqlComment) ?? [] : [],
      },
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const captures = buildCaptureSpecs(options);
  const generatedAt = new Date().toISOString();
  const outputPath = options.output
    ?? path.join("agents", `d1-insights-${generatedAt.replace(/[:.]/g, "-")}.json`);

  if (options.dryRun) {
    for (const capture of captures) {
      console.log([
        "npx", "wrangler", "d1", "insights", options.database,
        "--time-period", capture.period,
        "--sort-by", capture.sortBy,
        "--limit", String(options.limit),
        "--config", options.config,
        "--json",
      ].join(" "));
    }
    return;
  }

  const commentIndex = await buildSqlCommentIndex();
  const results = [];
  for (const capture of captures) {
    const args = [
      "wrangler", "d1", "insights", options.database,
      "--time-period", capture.period,
      "--sort-by", capture.sortBy,
      "--limit", String(options.limit),
      "--config", options.config,
      "--json",
    ];
    console.error(`[d1-insights] ${args.join(" ")}`);
    const { stdout, stderr } = await runCommand("npx", args);
    const payload = JSON.parse(stdout);
    results.push({
      ...capture,
      stderr: stderr.trim() || undefined,
      rows: annotateRows(payload, commentIndex),
      raw: payload,
    });
  }

  const report = {
    generatedAt,
    database: options.database,
    captures: results,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[d1-insights] wrote ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
