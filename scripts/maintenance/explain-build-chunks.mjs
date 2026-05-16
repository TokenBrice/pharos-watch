#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const wantsJson = argv.includes("--json");
const reportIndex = argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;

const SIGNATURES_PATH = path.join(root, "scripts/lib/build-attribution-signatures.json");
const CHUNKS_DIR = path.join(root, "out/_next/static/chunks");

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function loadSignatures() {
  const raw = readFileSync(SIGNATURES_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected signature file to contain an array: ${SIGNATURES_PATH}`);
  }
  for (const entry of parsed) {
    if (!entry || typeof entry.name !== "string" || typeof entry.marker !== "string") {
      throw new Error(`Invalid signature entry in ${SIGNATURES_PATH}: ${JSON.stringify(entry)}`);
    }
  }
  return parsed;
}

function listJsChunks() {
  if (!existsSync(CHUNKS_DIR)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(CHUNKS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".js")) continue;
    const abs = path.join(CHUNKS_DIR, entry.name);
    files.push({ name: entry.name, abs, size: statSync(abs).size });
  }
  return files.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

function classifyChunk(content, signatures) {
  const hits = [];
  for (const { name, marker } of signatures) {
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(marker, idx)) !== -1) {
      count += 1;
      idx += marker.length;
    }
    if (count > 0) hits.push({ name, count });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits;
}

function buildReport() {
  const signatures = loadSignatures();
  const chunks = listJsChunks();
  const entries = chunks.map((chunk) => {
    const content = readFileSync(chunk.abs, "utf8");
    const hits = classifyChunk(content, signatures);
    return {
      chunk: chunk.name,
      size: chunk.size,
      classifications: hits.map((hit) => hit.name),
      hits,
    };
  });
  return { generatedAt: new Date().toISOString(), entries };
}

function printTable(report) {
  console.log("# Build Chunk Attribution");
  console.log(`scanned chunks: ${report.entries.length}`);
  console.log("");
  console.log("size       classifications                                                  chunk");
  for (const entry of report.entries) {
    const cls = entry.classifications.length > 0 ? entry.classifications.join(",") : "(unclassified)";
    console.log(`${formatBytes(entry.size).padStart(9)}  ${cls.padEnd(64)}  ${entry.chunk}`);
  }
}

function main() {
  if (!existsSync(CHUNKS_DIR)) {
    console.error(`[explain-build-chunks] Missing ${CHUNKS_DIR}. Run npm run build first.`);
    process.exit(1);
  }

  const report = buildReport();

  if (reportPath) {
    const absReportPath = path.isAbsolute(reportPath) ? reportPath : path.join(root, reportPath);
    writeFileSync(absReportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[explain-build-chunks] Wrote report to ${path.relative(root, absReportPath)}`);
  }

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printTable(report);
}

main();
