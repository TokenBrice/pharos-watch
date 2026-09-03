#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseStrictCliArgs, assertCliUsage, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { runShellCommand, type CommandImplementation } from "../lib/command-runner.mts";

const execFileAsync = promisify(execFile);
const MANIFEST_KEY = "safety-map:latest.json";
const FRESH_SAME_DAY_SECONDS = 6 * 3600;
const MAX_MANIFEST_BYTES = 16_384;

const USAGE = `Usage: npx tsx scripts/maintenance/publish-safety-score-map.ts <phase> [options]

Phases:
  plan       Inspect KV and decide whether this run should render
  render     Render and validate the daily map; build its KV manifest
  publish    Refuse backwards publication, then write and verify KV in order
  summary    Append the run summary to GITHUB_STEP_SUMMARY (or stdout)

Options:
  --state <path>         Run-state JSON (default: agents/safety-score-map/ci/publish-state.json)
  --out-dir <path>       Render output directory (default: agents/safety-score-map/ci)
  --event-name <name>    GitHub event name (plan; default: GITHUB_EVENT_NAME or workflow_dispatch)
  --job-status <status>  GitHub job status (summary; default: unknown)
  --dry-run              Plan only: inspect and print the decision without KV writes
  --plan-token <token>   Render/publish token emitted by plan; refuses a different plan
  -h, --help             Show this help`;

export interface SafetyMapKvAdapter {
  list(prefix: string): Promise<string[]>;
  get(key: string, options?: { text?: boolean }): Promise<Buffer>;
  put(key: string, path: string): Promise<void>;
}

interface SafetyMapManifest {
  date: string;
  asOfSec: unknown;
  renderedAtSec: unknown;
  edition: unknown;
  methodologyVersion: unknown;
  publicationStatus: unknown;
  updatedAt: unknown;
  publicationHealth: unknown;
  counts: Record<string, unknown>;
  mapSummary?: unknown;
  bytes: { png: number; alt: number };
}

export interface SafetyMapPublishState {
  phase: "planned" | "rendered" | "published";
  eventName: string;
  plannedAtSec: number;
  planToken?: string;
  alreadyPublished: boolean;
  hadManifest: boolean;
  priorManifest?: Record<string, unknown>;
  manifest?: SafetyMapManifest;
  manifestPath?: string;
  renderSeconds?: number;
}

export interface PublicationIo {
  stdout: { write(text: string): unknown };
  warning: (title: string, message: string) => void;
  writeOutput: (name: string, value: string | number | boolean) => void;
}

const DEFAULT_IO: PublicationIo = {
  stdout: process.stdout,
  warning: (title, message) => process.stdout.write(`::warning title=${title}::${message}\n`),
  writeOutput: (name, value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  },
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function extractJson(raw: Buffer, opening: "[" | "{"): unknown {
  const text = raw.toString("utf8");
  const closing = opening === "[" ? "]" : "}";
  const start = text.indexOf(opening);
  const end = text.lastIndexOf(closing);
  if (start < 0 || end < start) throw new Error(`output did not contain a JSON ${opening === "[" ? "array" : "object"}`);
  return JSON.parse(text.slice(start, end + 1)) as unknown;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

export class WranglerSafetyMapKvAdapter implements SafetyMapKvAdapter {
  constructor(
    private readonly namespaceId: string,
    private readonly wranglerPath = resolve("node_modules/.bin/wrangler"),
  ) {
    if (!namespaceId.trim()) throw new Error("KV_NAMESPACE_ID is required");
  }

  private async run(args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync(this.wranglerPath, args, {
        encoding: "buffer",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        maxBuffer: 32 * 1024 * 1024,
      });
      return Buffer.from(stdout);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`wrangler ${args.slice(0, 4).join(" ")} failed: ${detail}`, { cause: error });
    }
  }

  async list(prefix: string): Promise<string[]> {
    const raw = await this.run(["kv", "key", "list", "--remote", `--namespace-id=${this.namespaceId}`, `--prefix=${prefix}`]);
    let parsed: unknown;
    try {
      parsed = extractJson(raw, "[");
    } catch (error) {
      throw new Error(`Unreadable KV listing for ${prefix}; refusing to guess what is live.`, { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error(`Unreadable KV listing for ${prefix}; expected an array.`);
    return parsed.flatMap((entry) => {
      const name = typeof entry === "object" && entry !== null ? (entry as { name?: unknown }).name : null;
      return typeof name === "string" ? [name] : [];
    });
  }

  get(key: string, options: { text?: boolean } = {}): Promise<Buffer> {
    return this.run([
      "kv", "key", "get", "--remote", `--namespace-id=${this.namespaceId}`,
      ...(options.text ? ["--text"] : []), key,
    ]);
  }

  async put(key: string, path: string): Promise<void> {
    await this.run(["kv", "key", "put", "--remote", `--namespace-id=${this.namespaceId}`, key, `--path=${path}`]);
  }
}

function readState(path: string): SafetyMapPublishState {
  return asObject(JSON.parse(readFileSync(path, "utf8")), `Invalid publication state at ${path}`) as unknown as SafetyMapPublishState;
}

function writeState(path: string, state: SafetyMapPublishState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function parseManifest(raw: Buffer): Record<string, unknown> {
  try {
    return asObject(extractJson(raw, "{"), "manifest is not a JSON object");
  } catch (error) {
    throw new Error(`${MANIFEST_KEY} exists but did not read back as JSON. Refusing to publish over an unknown state.`, { cause: error });
  }
}

export async function planSafetyMapPublication({
  adapter,
  dryRun = false,
  eventName,
  io = DEFAULT_IO,
  nowSec = Math.floor(Date.now() / 1000),
  statePath,
}: {
  adapter: SafetyMapKvAdapter;
  dryRun?: boolean;
  eventName: string;
  io?: PublicationIo;
  nowSec?: number;
  statePath: string;
}): Promise<SafetyMapPublishState> {
  const manifestNames = await adapter.list(MANIFEST_KEY);
  const hadManifest = manifestNames.includes(MANIFEST_KEY);
  const priorManifest = hadManifest ? parseManifest(await adapter.get(MANIFEST_KEY, { text: true })) : undefined;

  const today = utcDate(nowSec);
  const ageSec = nowSec - Number(priorManifest?.asOfSec);
  const fresh = Number.isFinite(ageSec) && ageSec >= 0 && ageSec < FRESH_SAME_DAY_SECONDS;
  const alreadyPublished = eventName === "schedule" && priorManifest?.date === today && fresh;
  const planToken = buildPlanToken({
    alreadyPublished,
    eventName,
    hadManifest,
    nowSec,
    priorManifest,
  });
  const state: SafetyMapPublishState = {
    phase: "planned",
    eventName,
    plannedAtSec: nowSec,
    planToken,
    alreadyPublished,
    hadManifest,
    ...(priorManifest ? { priorManifest } : {}),
  };

  if (!hadManifest) io.stdout.write(`No existing ${MANIFEST_KEY} — treating this as the first publication.\n`);
  io.stdout.write(alreadyPublished
    ? `Manifest for ${today} is live with data ${Math.round(ageSec / 60)}m old — skipping the re-render.\n`
    : `Proceeding: manifest date=${priorManifest?.date ?? "none"}, today=${today}, event=${eventName}, data age=${Math.round(ageSec / 60)}m.\n`);

  if (!dryRun) writeState(statePath, state);
  io.writeOutput("already_published", alreadyPublished);
  io.writeOutput("should_render", !alreadyPublished);
  io.writeOutput("has_manifest", hadManifest);
  io.writeOutput("plan_token", planToken);
  return state;
}

function buildPlanToken({
  alreadyPublished,
  eventName,
  hadManifest,
  nowSec,
  priorManifest,
}: {
  alreadyPublished: boolean;
  eventName: string;
  hadManifest: boolean;
  nowSec: number;
  priorManifest?: Record<string, unknown>;
}): string {
  return sha256(Buffer.from(JSON.stringify({
    version: 1,
    eventName,
    plannedAtSec: nowSec,
    alreadyPublished,
    hadManifest,
    priorManifest: priorManifest ?? null,
  }), "utf8"));
}

function assertPlanToken(state: SafetyMapPublishState, expectedPlanToken?: string): void {
  if (expectedPlanToken === undefined) return;
  const computedPlanToken = buildPlanToken({
    alreadyPublished: state.alreadyPublished,
    eventName: state.eventName,
    hadManifest: state.hadManifest,
    nowSec: state.plannedAtSec,
    priorManifest: state.priorManifest,
  });
  if (!state.planToken || state.planToken !== expectedPlanToken || state.planToken !== computedPlanToken) {
    throw new Error("Publication state does not match the supplied plan token; refusing to continue.");
  }
}

function buildManifest(outDir: string): { manifest: SafetyMapManifest; manifestPath: string } {
  const png = join(outDir, "latest.png");
  const alt = join(outDir, "latest.alt.json");
  const renderManifest = join(outDir, "latest.manifest.json");
  const meta = asObject(JSON.parse(readFileSync(renderManifest, "utf8")), "latest.manifest.json must be an object");
  const required = ["date", "asOfSec", "renderedAtSec", "edition", "counts"];
  const absent = required.filter((key) => meta[key] === undefined || meta[key] === null);
  if (absent.length > 0) throw new Error(`latest.manifest.json is missing ${absent.join(", ")}. The generator output contract changed.`);
  if (meta.edition !== "daily") throw new Error(`Rendered edition is "${meta.edition}", expected "daily".`);
  if (typeof meta.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) throw new Error(`Bad archive date: "${meta.date}" is not YYYY-MM-DD.`);
  const runDate = utcDate(Number(meta.renderedAtSec));
  if (meta.date !== runDate) throw new Error(`Archive date is not the run date: render manifest says ${meta.date}, renderedAtSec resolves to ${runDate} UTC.`);
  const manifest: SafetyMapManifest = {
    date: meta.date,
    asOfSec: meta.asOfSec,
    renderedAtSec: meta.renderedAtSec,
    edition: meta.edition,
    methodologyVersion: meta.methodologyVersion ?? null,
    publicationStatus: meta.publicationStatus ?? null,
    updatedAt: meta.updatedAt ?? null,
    publicationHealth: meta.publicationHealth ?? null,
    counts: asObject(meta.counts, "latest.manifest.json counts must be an object"),
    ...(meta.mapSummary === undefined ? {} : { mapSummary: meta.mapSummary }),
    bytes: { png: statSync(png).size, alt: statSync(alt).size },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestText, "utf8") >= MAX_MANIFEST_BYTES) throw new Error(`KV manifest is ${Buffer.byteLength(manifestText, "utf8")} bytes; it must stay under ${MAX_MANIFEST_BYTES} bytes.`);
  const manifestPath = join(outDir, "kv-manifest.json");
  writeFileSync(manifestPath, manifestText, "utf8");
  return { manifest, manifestPath };
}

export async function renderSafetyMapPublication({
  commandRunner = runShellCommand,
  io = DEFAULT_IO,
  outDir,
  planToken,
  statePath,
}: {
  commandRunner?: CommandImplementation;
  io?: PublicationIo;
  outDir: string;
  planToken?: string;
  statePath: string;
}): Promise<SafetyMapPublishState> {
  const state = readState(statePath);
  assertPlanToken(state, planToken);
  if (state.alreadyPublished) return state;
  const started = Date.now();
  const command = `npm run build:safety-score-map -- --out ${shellQuote(join(outDir, "latest.png"))}`;
  const result = await commandRunner(command, {}, {});
  const status = typeof result === "number" ? result : result.status;
  if (status !== 0) {
    writeState(statePath, state);
    throw new Error(`Safety Map render failed with status ${status}`);
  }
  const { manifest, manifestPath } = buildManifest(outDir);
  Object.assign(state, { phase: "rendered", manifest, manifestPath, renderSeconds: Math.floor((Date.now() - started) / 1000) });
  writeState(statePath, state);
  io.writeOutput("date", manifest.date);
  return state;
}

export function safetyMapPublicationEntries(state: SafetyMapPublishState, outDir: string): Array<{ key: string; path: string; verify?: true }> {
  if (!state.manifest || !state.manifestPath) throw new Error("Publication state has no rendered manifest");
  return [
    { key: "safety-map:alt:latest", path: join(outDir, "latest.alt.json") },
    { key: `safety-map:${state.manifest.date}.png`, path: join(outDir, "latest.png"), verify: true },
    { key: "safety-map:latest.png", path: join(outDir, "latest.png") },
    { key: MANIFEST_KEY, path: state.manifestPath },
  ];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function publishSafetyMapPublication({
  adapter,
  io = DEFAULT_IO,
  outDir,
  planToken,
  statePath,
}: {
  adapter: SafetyMapKvAdapter;
  io?: PublicationIo;
  outDir: string;
  planToken?: string;
  statePath: string;
}): Promise<SafetyMapPublishState> {
  const state = readState(statePath);
  assertPlanToken(state, planToken);
  if (state.alreadyPublished) return state;
  if (!state.manifest) throw new Error("Publication state has not completed the render phase");
  if (state.hadManifest) {
    const priorAt = Number(state.priorManifest?.renderedAtSec ?? state.priorManifest?.asOfSec ?? 0);
    if (!Number.isFinite(priorAt)) throw new Error("The live manifest has no comparable timestamp. Refusing to publish over it.");
    if (priorAt > Number(state.manifest.renderedAtSec)) {
      throw new Error(`Backwards publish refused: live render ${priorAt} (${new Date(priorAt * 1000).toISOString()}) is later than this run at ${state.manifest.renderedAtSec}. Nothing was published.`);
    }
    io.stdout.write(`Ordering OK: live=${priorAt} < this run=${state.manifest.renderedAtSec}\n`);
  }
  const entries = safetyMapPublicationEntries(state, outDir);
  for (const entry of entries) {
    await adapter.put(entry.key, entry.path);
    if (entry.verify) {
      const expected = sha256(readFileSync(entry.path));
      const actual = sha256(await adapter.get(entry.key));
      if (actual !== expected) throw new Error(`${entry.key} failed SHA-256 readback comparison. The stable latest image remains untouched and the manifest was NOT written.`);
      io.stdout.write(`Readback OK: ${entry.key} = sha256:${actual}.\n`);
    }
  }
  state.phase = "published";
  writeState(statePath, state);
  return state;
}


export function buildSafetyMapSummary(state: SafetyMapPublishState | null, jobStatus: string): string {
  const manifest = state?.manifest;
  const value = (input: unknown) => input === undefined || input === null ? "—" : String(input);
  const lines = [
    `## Safety Map refresh — ${jobStatus}`, "", "| | |", "|---|---|",
    `| Archive date (UTC) | \`${value(manifest?.date)}\` |`,
    `| Data \`asOfSec\` | \`${value(manifest?.asOfSec)}\` |`,
    `| Safety Score source | \`${value(manifest?.publicationStatus)}\` |`,
    `| Render started | \`${value(manifest?.renderedAtSec)}\` |`,
    `| Render wall-clock | ${value(state?.renderSeconds)}s |`,
    `| Graded coins | ${value(manifest?.counts.graded)} |`,
    `| Not rated | ${value(manifest?.counts.notRated)} |`,
    `| PNG | ${value(manifest?.bytes.png)} bytes |`,
    `| Alt text | ${value(manifest?.bytes.alt)} bytes |`,
    `| Prior manifest existed | ${value(state?.hadManifest ?? "unknown")} |`, "",
  ];
  if (state?.alreadyPublished) {
    lines.push("### Skipped — today is already published", "", "The live `safety-map:latest.json` already carries today's date with fresh", "data, so this scheduled retry slot exited without rendering or writing.");
  } else if (jobStatus === "success" && state?.phase === "published" && manifest) {
    lines.push("### Published keys", "", ...safetyMapPublicationEntries(state, dirname(state.manifestPath ?? "")).map(({ key }) => `- \`${key}\`${key === MANIFEST_KEY ? " — manifest, written last" : key === `safety-map:${manifest.date}.png` ? " — the URL the digest embeds" : ""}`));
  } else {
    lines.push("### Nothing was committed", "", "The run did not reach the manifest write, so `safety-map:latest.json` still", "points at the previous complete key set and consumers are unaffected.", "", "The digest is not blocked by this miss; it may carry forward a recent dated map", "within its bounded continuity window and labels the date it depicts.");
  }
  return `${lines.join("\n")}\n`;
}

function defaultAdapter(): SafetyMapKvAdapter {
  return new WranglerSafetyMapKvAdapter(process.env.KV_NAMESPACE_ID ?? "");
}

export async function runSafetyMapPublicationCli(argv: readonly string[], io: PublicationIo = DEFAULT_IO): Promise<void> {
  const { positionals, values } = parseStrictCliArgs(argv, {
    allowPositionals: true,
    options: {
      state: { type: "string" },
      "out-dir": { type: "string" },
      "event-name": { type: "string" },
      "job-status": { type: "string" },
      "dry-run": { type: "boolean" },
      "plan-token": { type: "string" },
    },
  });
  if (writeCliHelpIfRequested(values, USAGE, io.stdout)) return;
  assertCliUsage(positionals.length === 1, "exactly one phase is required");
  const phase = positionals[0];
  assertCliUsage(["plan", "render", "publish", "summary"].includes(phase), `unknown phase: ${phase}`);
  assertCliUsage(values["dry-run"] !== true || phase === "plan", "--dry-run is only valid with plan");
  const outDir = resolve(typeof values["out-dir"] === "string" ? values["out-dir"] : "agents/safety-score-map/ci");
  const statePath = resolve(typeof values.state === "string" ? values.state : join(outDir, "publish-state.json"));
  const planToken = typeof values["plan-token"] === "string" ? values["plan-token"] : undefined;
  if (phase === "plan") {
    await planSafetyMapPublication({ adapter: defaultAdapter(), dryRun: values["dry-run"] === true, eventName: typeof values["event-name"] === "string" ? values["event-name"] : process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch", io, statePath });
  } else if (phase === "render") {
    await renderSafetyMapPublication({ io, outDir, planToken, statePath });
  } else if (phase === "publish") {
    await publishSafetyMapPublication({ adapter: defaultAdapter(), io, outDir, planToken, statePath });
  } else {
    const state = existsSync(statePath) ? readState(statePath) : null;
    const summary = buildSafetyMapSummary(state, typeof values["job-status"] === "string" ? values["job-status"] : "unknown");
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    else io.stdout.write(summary);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCliEntrypoint(() => runSafetyMapPublicationCli(process.argv.slice(2)), { label: "publish-safety-score-map", usage: USAGE });
}
