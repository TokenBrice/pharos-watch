#!/usr/bin/env node
/**
 * Generates the public-endpoint quick reference section inside
 * `docs/api-reference.md` from `public/openapi.json`.
 *
 * Sync model:
 * - The file is overwhelmingly hand-written editorial content: cache profiles,
 *   per-endpoint response shapes, field tables, error semantics, admin
 *   endpoints (which openapi.json deliberately omits), and rich commentary.
 * - This generator only manages ONE block, delimited by GENERATED markers,
 *   that summarises the public-endpoint catalogue exposed by openapi.json.
 *   Everything outside those markers is preserved verbatim.
 * - Hand-written editorial sections may optionally be wrapped in
 *   HAND-WRITTEN markers as guard-rails for human readers. The generator
 *   does not parse those markers; any content outside GENERATED-START/END
 *   is treated as hand-written.
 *
 * Usage:
 *   node --import tsx scripts/maintenance/generate-api-reference.ts           # write
 *   node --import tsx scripts/maintenance/generate-api-reference.ts --check   # CI: exit 1 if stale
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OPENAPI_PATH = resolve(ROOT, "public/openapi.json");
const DOC_PATH = resolve(ROOT, "docs/api-reference.md");

const GENERATED_KEY = "public-endpoints-quick-reference";
const START_MARKER = `<!-- GENERATED-START: ${GENERATED_KEY} -->`;
const END_MARKER = `<!-- GENERATED-END: ${GENERATED_KEY} -->`;

const CHECK_MODE = process.argv.includes("--check");

interface OpenApiSpec {
  paths: Record<string, unknown>;
  info?: Record<string, unknown>;
}

interface EndpointRow {
  method: string;
  path: string;
  summary: string;
  tags: string;
  auth: string;
  parameters: string;
  statusCodes: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadOpenapi(): OpenApiSpec {
  const raw = readFileSync(OPENAPI_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.paths)) {
    throw new Error("openapi.json is missing `paths`");
  }
  return {
    paths: parsed.paths,
    info: isRecord(parsed.info) ? parsed.info : undefined,
  };
}

function escapeCell(value: unknown): string {
  // Escape pipe characters so markdown table cells stay valid.
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function formatParams(parameters: unknown): string {
  if (!Array.isArray(parameters) || parameters.length === 0) return "—";
  return parameters
    .map((parameter) => {
      if (!isRecord(parameter)) return "";
      const req = parameter.required ? "" : "?";
      return `\`${String(parameter.name ?? "")}${req}\``;
    })
    .filter(Boolean)
    .join(", ");
}

function authForOperation(operation: Record<string, unknown>): string {
  // Per-operation `security: []` overrides the global API-key requirement.
  if (Array.isArray(operation.security)) {
    if (operation.security.length === 0) return "none";
    return "X-API-Key";
  }
  return "X-API-Key";
}

function collectEndpoints(spec: OpenApiSpec): EndpointRow[] {
  const rows: EndpointRow[] = [];
  const paths = spec.paths;
  for (const path of Object.keys(paths)) {
    const pathItem = paths[path];
    if (!isRecord(pathItem)) continue;
    for (const method of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      const op = pathItem[method];
      if (!isRecord(op)) continue;
      const tags = Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string").join(", ") : "";
      const statusCodes = isRecord(op.responses)
        ? Object.keys(op.responses).sort().join(", ")
        : "";
      rows.push({
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === "string" ? op.summary : typeof op.operationId === "string" ? op.operationId : "",
        tags,
        auth: authForOperation(op),
        parameters: formatParams(op.parameters),
        statusCodes,
      });
    }
  }
  // Stable order: path then method.
  rows.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return rows;
}

function renderTable(rows: readonly EndpointRow[]): string {
  const header = "| Method | Path | Summary | Tags | Auth | Parameters | Status codes |";
  const sep = "| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |";
  const body = rows.map((row) => (
    `| ${row.method} | \`${escapeCell(row.path)}\` | ${escapeCell(row.summary)} | ${escapeCell(row.tags)} | ${row.auth} | ${row.parameters} | ${row.statusCodes} |`
  ));
  return [header, sep, ...body].join("\n");
}

function renderGeneratedBlock(spec: OpenApiSpec): string {
  const rows = collectEndpoints(spec);
  const lines = [
    START_MARKER,
    "<!-- This block is generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json. -->",
    "<!-- Do not edit by hand. Run `node --import tsx scripts/maintenance/generate-api-reference.ts` to refresh. -->",
    "",
    "### Public Endpoints Quick Reference",
    "",
    `Generated from \`public/openapi.json\` (\`${typeof spec.info?.title === "string" ? spec.info.title : "Pharos API"}\` v${typeof spec.info?.version === "string" ? spec.info.version : ""}). The OpenAPI artifact intentionally excludes Cloudflare-Access-gated admin routes, self-serve key issuance POST endpoints, feedback submission, Telegram webhook ingestion, Telegram Mini App endpoints, and dynamic OG image routes. Those endpoints are documented in the hand-written sections below.`,
    "",
    `Total documented public operations: **${rows.length}**.`,
    "",
    renderTable(rows),
    "",
    END_MARKER,
  ];
  return lines.join("\n");
}

function replaceGeneratedBlock(doc: string, generatedBlock: string): string {
  const startIdx = doc.indexOf(START_MARKER);
  const endIdx = doc.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Could not find generated markers in ${DOC_PATH}. Expected '${START_MARKER}' and '${END_MARKER}'.`
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`Generated end marker precedes start marker in ${DOC_PATH}.`);
  }
  const before = doc.slice(0, startIdx);
  const after = doc.slice(endIdx + END_MARKER.length);
  return `${before}${generatedBlock}${after}`;
}

function main() {
  const spec = loadOpenapi();
  const existing = readFileSync(DOC_PATH, "utf8");
  const generatedBlock = renderGeneratedBlock(spec);
  const next = replaceGeneratedBlock(existing, generatedBlock);

  if (CHECK_MODE) {
    if (next !== existing) {
      console.error(
        "docs/api-reference.md is out of date. Run `node --import tsx scripts/maintenance/generate-api-reference.ts`."
      );
      process.exit(1);
    }
    console.log("docs/api-reference.md is current");
    return;
  }

  if (next === existing) {
    console.log("docs/api-reference.md unchanged");
    return;
  }

  writeFileSync(DOC_PATH, next, "utf8");
  console.log("docs/api-reference.md regenerated");
}

main();
