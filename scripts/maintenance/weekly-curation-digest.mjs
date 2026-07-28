#!/usr/bin/env node
/**
 * Human-readable weekly curation rollup. Prints a structured markdown
 * digest covering each editorial stream tracked by Pharos:
 *
 *   1. oneLiner coverage (binary: 100% expected)
 *   2. mechanismArchetype coverage in the top-segment cohort
 *   3. proofOfReserves.attestorTier coverage (independent-audit cohort)
 *   4. AI summary staleness (>180 days for active coins)
 *   5. Chart annotation queue health
 *
 * Pure stdout by default. With --write the digest is also archived to
 * `agents/curation-digest-<date>.md`.
 *
 * Standalone command (`npm run digest:curation`). NOT part of
 * The scheduled full test suite enforces the editorial
 * floors; the digest is the human rollup read on a calendar cadence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const ROOT = process.cwd();
const COINS_FILE = resolve(ROOT, "shared/data/stablecoins/coins.generated.json");
const SUMMARIES_FILE = resolve(ROOT, "data/ai-summaries.json");
const BASELINE_FILE = resolve(ROOT, "scripts/lib/curation-baseline-caps.json");
const CANDIDATES_FILE = resolve(ROOT, "agents/annotation-candidates.md");
const CURATED_ANNOTATIONS_FILE = resolve(ROOT, "shared/data/annotations/curated-annotations.ts");

const AI_SUMMARY_STALENESS_DAYS = 180;
const QUEUE_WARN_ROW_THRESHOLD = 30;
const QUEUE_WARN_AGE_DAYS = 60;
const ANNOTATION_STALE_YEARS = 2;
const QUARTERLY_HAND_CHECK_DAYS = 90;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readTextOrEmpty(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function parseArgs(argv) {
  return { write: argv.includes("--write") };
}

function status(coin) {
  return coin.status ?? "active";
}

function isActiveOrPreLaunch(coin) {
  const s = status(coin);
  return s === "active" || s === "pre-launch";
}

function isVariant(coin) {
  return typeof coin.variantOf === "string" && coin.variantOf.length > 0;
}

export function analyzeOneLiner(coins) {
  const inScope = coins.filter(isActiveOrPreLaunch);
  const missing = inScope
    .filter((c) => !c.oneLiner || String(c.oneLiner).trim() === "")
    .map((c) => c.id)
    .sort();
  return { total: inScope.length, missing };
}

export function analyzeArchetype(coins, baseline) {
  const byId = new Map(coins.map((c) => [c.id, c]));
  const tracked = [];
  let variants = 0;
  let frozen = 0;
  const unknown = [];
  for (const id of baseline.topByRank) {
    const coin = byId.get(id);
    if (!coin) {
      unknown.push(id);
      continue;
    }
    if (status(coin) === "frozen") {
      frozen += 1;
      continue;
    }
    if (isVariant(coin)) {
      variants += 1;
      continue;
    }
    tracked.push(coin);
  }
  const missing = tracked
    .filter((c) => !c.mechanismArchetype)
    .map((c) => c.id)
    .sort();
  return {
    segment: baseline.segmentLabel,
    segmentTotal: baseline.topByRank.length,
    tracked: tracked.length,
    variants,
    frozen,
    unknown,
    missing,
  };
}

export function analyzeAttestorTier(coins) {
  const auditCoins = coins.filter((c) => c.proofOfReserves && c.proofOfReserves.type === "independent-audit");
  const missing = auditCoins
    .filter((c) => !c.proofOfReserves || !c.proofOfReserves.attestorTier)
    .map((c) => c.id)
    .sort();
  return { total: auditCoins.length, missing };
}

function daysBetween(aIso, bIso) {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function analyzeSummaryStaleness(coins, summaries) {
  const today = todayIso();
  const stale = [];
  const missing = [];
  for (const coin of coins) {
    if (status(coin) !== "active") continue;
    const entry = summaries[coin.id];
    if (!entry || typeof entry.text !== "string" || entry.text.trim() === "") {
      missing.push(coin.id);
      continue;
    }
    const updated = typeof entry.updatedAt === "string" ? entry.updatedAt : "";
    const age = updated ? daysBetween(updated, today) : null;
    if (age == null || age > AI_SUMMARY_STALENESS_DAYS) {
      const hasNotice = Array.isArray(coin.notices) && coin.notices.length > 0;
      const hasFrozenObit = typeof coin.frozenAt === "string";
      stale.push({
        id: coin.id,
        ageDays: age,
        lastUpdate: updated || "(unknown)",
        flag: hasNotice
          ? "has notices — refresh likely warranted"
          : hasFrozenObit
            ? "frozen — past-tense refresh due"
            : "",
      });
    }
  }
  stale.sort((a, b) => (b.ageDays ?? Number.POSITIVE_INFINITY) - (a.ageDays ?? Number.POSITIVE_INFINITY));
  missing.sort();
  return { stale, missing };
}

function parseAnnotationsTs(text) {
  const timestamps = [];
  const re = /Date\.UTC\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const yyyy = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const ts = Date.UTC(yyyy, m, d);
    if (Number.isFinite(ts)) timestamps.push(ts);
  }
  return timestamps;
}

function analyzeAnnotationQueue(queueText, curatedText) {
  const lines = queueText.split(/\r?\n/);
  let rowCount = 0;
  let oldestDate = null;
  const dateHeaderRe = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/;
  let activeDate = null;
  for (const line of lines) {
    const header = dateHeaderRe.exec(line);
    if (header) {
      activeDate = header[1];
      if (oldestDate == null || activeDate < oldestDate) oldestDate = activeDate;
      continue;
    }
    if (line.startsWith("- ") && line.includes(" | ")) {
      rowCount += 1;
    }
  }

  const lastSweptMatch = /<!--\s*last_swept_at:\s*(\d{4}-\d{2}-\d{2})\s*-->/.exec(queueText);
  const lastSweptAt = lastSweptMatch ? lastSweptMatch[1] : null;

  const ts = parseAnnotationsTs(curatedText);
  const cutoffMs = Date.now() - ANNOTATION_STALE_YEARS * 365.25 * 24 * 60 * 60 * 1000;
  let staleCount = 0;
  for (const value of ts) if (value < cutoffMs) staleCount += 1;

  const warnings = [];
  if (rowCount > QUEUE_WARN_ROW_THRESHOLD) {
    warnings.push(`queue length ${rowCount} exceeds ${QUEUE_WARN_ROW_THRESHOLD}-row threshold`);
  }
  if (oldestDate) {
    const age = daysBetween(oldestDate, todayIso());
    if (age != null && age > QUEUE_WARN_AGE_DAYS) {
      warnings.push(`oldest row is ${age} days old (>${QUEUE_WARN_AGE_DAYS}d)`);
    }
  }

  return {
    queuePresent: queueText.length > 0,
    rowCount,
    oldestDate,
    lastSweptAt,
    annotationCount: ts.length,
    annotationsOlderThanYears: staleCount,
    warnings,
  };
}

function joinList(items, limit = 12) {
  if (items.length === 0) return "(none)";
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
}

function renderHeader(quarterlyDueIn) {
  const dueLine =
    quarterlyDueIn <= 0
      ? `**Quarterly hand-check overdue by ${Math.abs(quarterlyDueIn)} days.**`
      : `Quarterly hand-check due in ~${quarterlyDueIn} days.`;
  return [
    `# Curation digest — ${todayIso()}`,
    "",
    "Generated by `npm run digest:curation`. Pharos editorial streams at a glance.",
    "",
    `_${dueLine}_`,
    "",
  ].join("\n");
}

function renderOneLiner(report) {
  const lines = [`## oneLiner coverage`, ""];
  if (report.missing.length === 0) {
    lines.push(`Status: **OK** — ${report.total}/${report.total} active/pre-launch coins have a oneLiner.`);
  } else {
    lines.push(
      `Status: **DRIFT** — ${report.total - report.missing.length}/${report.total} coverage; ${report.missing.length} missing.`,
    );
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderArchetype(report) {
  const lines = [`## mechanismArchetype coverage (${report.segment})`, ""];
  const have = report.tracked - report.missing.length;
  const pct = report.tracked === 0 ? "0.0" : ((have / report.tracked) * 100).toFixed(1);
  lines.push(
    `Tracked non-variant coins in cohort: ${have}/${report.tracked} have an archetype (${pct}%); ${report.variants} variants and ${report.frozen} frozen excluded.`,
  );
  if (report.missing.length > 0) {
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  if (report.unknown.length > 0) {
    lines.push(
      `Baseline drift: ${report.unknown.length} baseline IDs missing from registry (${joinList(report.unknown)}). Refresh \`scripts/lib/curation-baseline-caps.json\`.`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderAttestor(report) {
  const lines = [`## proofOfReserves.attestorTier coverage`, ""];
  const have = report.total - report.missing.length;
  const pct = report.total === 0 ? "0.0" : ((have / report.total) * 100).toFixed(1);
  lines.push(`Independent-audit coins with attestorTier: ${have}/${report.total} (${pct}%).`);
  if (report.missing.length > 0) {
    lines.push(`Missing: ${joinList(report.missing)}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderSummary(report) {
  const lines = [`## AI summary staleness`, ""];
  lines.push(
    `Stale (>${AI_SUMMARY_STALENESS_DAYS}d since updatedAt) active summaries: ${report.stale.length}. Missing: ${report.missing.length}.`,
  );
  if (report.missing.length > 0) {
    lines.push(`Missing entries: ${joinList(report.missing)}`);
  }
  if (report.stale.length > 0) {
    lines.push("");
    lines.push("Top stale entries:");
    for (const row of report.stale.slice(0, 10)) {
      const tag = row.flag ? ` — ${row.flag}` : "";
      const age = row.ageDays == null ? "n/a" : `${row.ageDays}d`;
      lines.push(`- ${row.id} — last update ${row.lastUpdate} (${age})${tag}`);
    }
    if (report.stale.length > 10) {
      lines.push(`- …and ${report.stale.length - 10} more`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderQueueHealth(report) {
  const lines = [`## Annotation queue health`, ""];
  if (!report.queuePresent) {
    lines.push(
      "Queue file `agents/annotation-candidates.md` not present. Run `npm run candidates:annotations` to seed it.",
    );
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`Rows pending review: ${report.rowCount}`);
  lines.push(`Last swept: ${report.lastSweptAt ?? "(never recorded)"}`);
  lines.push(`Oldest dated row: ${report.oldestDate ?? "(none)"}`);
  lines.push(
    `Curated annotations on file: ${report.annotationCount} total; ${report.annotationsOlderThanYears} are older than ${ANNOTATION_STALE_YEARS} years (quarterly hand-check anchors).`,
  );
  if (report.warnings.length > 0) {
    for (const warn of report.warnings) {
      lines.push(`WARN: ${warn}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function quarterlyDueIn(curatedText) {
  // Anchor to the digest file's mtime is unreliable across machines; instead
  // we anchor to the most recent date inserted into the curated file. The
  // hand-check is a calendar reminder — "review top-50-by-mcap coins for
  // annotations older than 24 months every ~90 days".
  const ts = parseAnnotationsTs(curatedText);
  if (ts.length === 0) return QUARTERLY_HAND_CHECK_DAYS;
  const latest = Math.max(...ts);
  const elapsed = Math.round((Date.now() - latest) / (1000 * 60 * 60 * 24));
  return QUARTERLY_HAND_CHECK_DAYS - elapsed;
}

function main() {
  const { write } = parseArgs(process.argv.slice(2));

  const coins = readJson(COINS_FILE);
  const summaries = readJson(SUMMARIES_FILE);
  const baseline = readJson(BASELINE_FILE);
  const queueText = readTextOrEmpty(CANDIDATES_FILE);
  const curatedText = readTextOrEmpty(CURATED_ANNOTATIONS_FILE);

  const oneLiner = analyzeOneLiner(coins);
  const archetype = analyzeArchetype(coins, baseline);
  const attestor = analyzeAttestorTier(coins);
  const summary = analyzeSummaryStaleness(coins, summaries);
  const queue = analyzeAnnotationQueue(queueText, curatedText);
  const dueIn = quarterlyDueIn(curatedText);

  const out = [
    renderHeader(dueIn),
    renderOneLiner(oneLiner),
    renderArchetype(archetype),
    renderAttestor(attestor),
    renderSummary(summary),
    renderQueueHealth(queue),
  ].join("\n");

  process.stdout.write(out);

  if (write) {
    const outPath = resolve(ROOT, `agents/curation-digest-${todayIso()}.md`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, out, "utf8");
    process.stderr.write(`\nArchived digest to ${outPath}\n`);
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
