import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { CRON_JOB_DEFINITIONS } from "@shared/lib/cron-jobs";

import {
  CAPABILITY_REGISTRY,
  CAPABILITY_STATES,
  type CapabilityDefinition,
  type CapabilityState,
} from "./capability-registry";

const DAY_SEC = 86_400;
const STALE_SOURCE_DAYS = 7;
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".sql", ".ts", ".tsx"]);

type DbRow = Record<string, unknown>;
type UsageAvailability = "bounded" | "partial" | "unavailable";

export interface GitCommitEvidence {
  hash: string;
  subject: string;
  files: string[];
}

export interface SourceStatusEvidence {
  source: string;
  lastCollectedAt: number;
  ok: boolean;
  skipped: boolean;
  note: string | null;
  error: string | null;
}

export interface TrafficEvidenceRow {
  period: string;
  path: string;
  pageviews: number;
  users: number;
}

export interface SearchEvidenceRow {
  period: string;
  path: string;
  clicks: number;
  impressions: number;
}

export interface ProductEventEvidenceRow {
  eventName: string;
  eventCount: number;
  users: number;
}

export interface ApiRouteEvidenceRow {
  route: string;
  requests: number;
}

export interface TelegramEvidence {
  latestDate: string | null;
  subscribers: number | null;
  activeWatchers: number | null;
  newWatchers: number;
  churned: number;
  usage: Array<{ eventType: string; count: number }>;
}

export interface ControlCenterEvidence {
  available: boolean;
  path: string | null;
  latestCollectedAt: number | null;
  warnings: string[];
  sourceStatuses: SourceStatusEvidence[];
  traffic: TrafficEvidenceRow[];
  search: SearchEvidenceRow[];
  productEvents: ProductEventEvidenceRow[];
  apiRoutes: ApiRouteEvidenceRow[];
  telegram: TelegramEvidence | null;
}

export interface RepositoryFootprint {
  sourceFiles: number;
  testFiles: number;
  approximateLoc: number;
}

export interface GitActivity {
  commits: number;
  fixes: number;
  recentSubjects: string[];
}

export interface CapabilityEvidence {
  capability: CapabilityDefinition;
  reviewDue: boolean;
  usageAvailability: UsageAvailability;
  traffic: TrafficEvidenceRow[];
  search: SearchEvidenceRow[];
  productEvents: ProductEventEvidenceRow[];
  apiRoutes: ApiRouteEvidenceRow[];
  telegram: TelegramEvidence | null;
  footprint: RepositoryFootprint;
  activity: GitActivity;
  measurementGaps: string[];
  attentionReasons: string[];
}

export interface CapabilityReviewReport {
  asOf: string;
  since: string;
  controlCenter: ControlCenterEvidence;
  capabilities: CapabilityEvidence[];
}

interface CliOptions {
  asOf: string;
  since: string;
  controlCenterDbPath: string | null;
  write: boolean;
}

function stringValue(row: DbRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberValue(row: DbRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function dateDaysBefore(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function currentUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseCliArgs(argv: string[]): CliOptions {
  let asOf = currentUtcDate();
  let since: string | null = null;
  let controlCenterDbPath: string | null = null;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--as-of" || arg === "--since" || arg === "--control-center-db") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--as-of") asOf = value;
      else if (arg === "--since") since = value;
      else controlCenterDbPath = value;
      continue;
    }
    if (arg === "--help") {
      process.stdout.write(
        [
          "Usage: npm run review:capabilities -- [options]",
          "",
          "--control-center-db <path>  Optional read-only aggregate usage source",
          "--since <YYYY-MM-DD>        Git activity start (default: 90 days before as-of)",
          "--as-of <YYYY-MM-DD>        Deterministic report date (default: today UTC)",
          "--write                     Write agents/capability-review-<as-of>.md",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!isIsoDate(asOf)) throw new Error(`Invalid --as-of date: ${asOf}`);
  const resolvedSince = since ?? dateDaysBefore(asOf, 90);
  if (!isIsoDate(resolvedSince)) throw new Error(`Invalid --since date: ${resolvedSince}`);
  if (resolvedSince > asOf) throw new Error(`--since must not be later than --as-of`);

  return { asOf, since: resolvedSince, controlCenterDbPath, write };
}

function normalizePublicPath(value: string): string {
  let path = value.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return path;
    }
  }
  path = path.split(/[?#]/, 1)[0] || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path !== "/" && !path.endsWith("/")) path += "/";
  return path.replace(/\/{2,}/g, "/");
}

export function routeMatches(pathValue: string, routePattern: string): boolean {
  const path = normalizePublicPath(pathValue);
  const pattern = normalizePublicPath(routePattern);
  if (pattern === "/") return path === "/";
  if (!pattern.includes("*")) return path.startsWith(pattern);

  const pathSegments = path.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length < patternSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment === "*" || (pathSegments[index] !== undefined && pathSegments[index] === segment),
  );
}

export function matchesCapabilityPath(file: string, codePaths: readonly string[]): boolean {
  return codePaths.some((prefix) => file === prefix || file.startsWith(`${prefix.replace(/\/$/, "")}/`));
}

function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)/.test(path) || /\.(test|spec)\.[^.]+$/.test(path);
}

function isExcludedFootprintFile(path: string): boolean {
  return (
    /(^|\/)(__fixtures__|__snapshots__|fixtures)(\/|$)/.test(path) ||
    /(^|\.)generated\./.test(path) ||
    path.endsWith(".snap") ||
    path === "next-env.d.ts"
  );
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path));
}

export function collectRepositoryFootprint(
  repoRoot: string,
  trackedFiles: readonly string[],
  codePaths: readonly string[],
): RepositoryFootprint {
  const matched = trackedFiles.filter(
    (file) => matchesCapabilityPath(file, codePaths) && !isExcludedFootprintFile(file) && isSourceFile(file),
  );
  const testFiles = matched.filter(isTestFile);
  const sourceFiles = matched.filter((file) => !isTestFile(file));
  let approximateLoc = 0;

  for (const file of sourceFiles) {
    const contents = readFileSync(resolve(repoRoot, file), "utf8");
    approximateLoc += contents === "" ? 0 : contents.split(/\r?\n/).length - (/\r?\n$/.test(contents) ? 1 : 0);
  }

  return { sourceFiles: sourceFiles.length, testFiles: testFiles.length, approximateLoc };
}

export function parseGitLog(output: string): GitCommitEvidence[] {
  return output
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header, ...lines] = chunk.split(/\r?\n/);
      const separator = header.indexOf("\x1f");
      if (separator < 0) throw new Error("Unrecognized git log record");
      return {
        hash: header.slice(0, separator),
        subject: header.slice(separator + 1),
        files: lines.map((line) => line.trim()).filter(Boolean),
      };
    });
}

export function collectGitActivity(commits: readonly GitCommitEvidence[], codePaths: readonly string[]): GitActivity {
  const matched = commits.filter((commit) => commit.files.some((file) => matchesCapabilityPath(file, codePaths)));
  return {
    commits: matched.length,
    fixes: matched.filter((commit) => /^fix(?:\(|:)/i.test(commit.subject)).length,
    recentSubjects: matched.slice(0, 5).map((commit) => commit.subject),
  };
}

function gitTrackedFiles(repoRoot: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
}

function gitActivity(repoRoot: string, since: string, asOf: string): GitCommitEvidence[] {
  const output = execFileSync(
    "git",
    [
      "log",
      `--since=${since}T00:00:00Z`,
      `--until=${asOf}T23:59:59Z`,
      "--format=%x1e%H%x1f%s",
      "--name-only",
      "--no-renames",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseGitLog(output);
}

export function validateCapabilityRegistry(
  registry: readonly CapabilityDefinition[],
  repoRoot: string,
  knownCronJobs: ReadonlySet<string> = new Set(CRON_JOB_DEFINITIONS.map((definition) => definition.job)),
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const states = new Set<string>(CAPABILITY_STATES);

  if (registry.length > 12) errors.push(`Registry has ${registry.length} capabilities; MVP limit is 12.`);

  for (const capability of registry) {
    const validId =
      capability.id.length > 0 &&
      capability.id
        .split("-")
        .every(
          (segment) =>
            segment.length > 0 &&
            [...segment].every(
              (character) => (character >= "a" && character <= "z") || (character >= "0" && character <= "9"),
            ),
        );
    if (!validId) {
      errors.push(`${capability.id || "<empty>"}: id must be a lowercase slug.`);
    }
    if (ids.has(capability.id)) errors.push(`${capability.id}: duplicate capability id.`);
    ids.add(capability.id);

    if (!capability.name.trim()) errors.push(`${capability.id}: name is required.`);
    if (!capability.purpose.trim()) errors.push(`${capability.id}: purpose is required.`);
    if (!capability.strategicRationale.trim()) errors.push(`${capability.id}: strategicRationale is required.`);
    if (!capability.decision.rationale.trim()) errors.push(`${capability.id}: decision rationale is required.`);
    if (!states.has(capability.decision.state)) {
      errors.push(`${capability.id}: unknown state ${capability.decision.state}.`);
    }
    if (!isIsoDate(capability.decision.reviewAfter)) {
      errors.push(`${capability.id}: reviewAfter must be an ISO date.`);
    }
    if (capability.decision.state === "unreviewed" && capability.decision.reviewedAt !== null) {
      errors.push(`${capability.id}: unreviewed capability must have reviewedAt=null.`);
    }
    if (capability.decision.state !== "unreviewed") {
      if (!capability.decision.reviewedAt || !isIsoDate(capability.decision.reviewedAt)) {
        errors.push(`${capability.id}: reviewed state requires an ISO reviewedAt date.`);
      } else if (
        isIsoDate(capability.decision.reviewAfter) &&
        capability.decision.reviewAfter < capability.decision.reviewedAt
      ) {
        errors.push(`${capability.id}: reviewAfter must not predate reviewedAt.`);
      }
    }

    for (const route of capability.routes) {
      if (!route.startsWith("/")) errors.push(`${capability.id}: route must start with /: ${route}`);
    }
    for (const path of capability.codePaths) {
      if (!existsSync(resolve(repoRoot, path))) errors.push(`${capability.id}: code path does not exist: ${path}`);
    }
    for (const job of capability.cronJobs) {
      if (!knownCronJobs.has(job)) errors.push(`${capability.id}: unknown cron job: ${job}`);
    }
  }

  return errors;
}

function unavailableControlCenter(path: string | null, warning: string): ControlCenterEvidence {
  return {
    available: false,
    path,
    latestCollectedAt: null,
    warnings: [warning],
    sourceStatuses: [],
    traffic: [],
    search: [],
    productEvents: [],
    apiRoutes: [],
    telegram: null,
  };
}

function rows(db: DatabaseSync, sql: string, params: Array<string | number> = []): DbRow[] {
  return db.prepare(sql).all(...params) as DbRow[];
}

function loadApiRoutes(db: DatabaseSync): ApiRouteEvidenceRow[] {
  const row = rows(
    db,
    `SELECT json_extract(payload, '$.topRoutes') AS top_routes
       FROM raw_pulls
      WHERE source = 'apikeys'
      ORDER BY collected_at DESC
      LIMIT 1`,
  )[0];
  const raw = row ? stringValue(row, "top_routes") : null;
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const route = "route" in item && typeof item.route === "string" ? item.route : null;
    const requests = "requests" in item && typeof item.requests === "number" ? item.requests : null;
    return route && requests !== null && Number.isFinite(requests) ? [{ route, requests }] : [];
  });
}

function loadTelegram(db: DatabaseSync, since: string, asOf: string): TelegramEvidence {
  const latest = rows(
    db,
    `SELECT date, subscribers, active_watchers
       FROM telegram_daily
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT 1`,
    [asOf],
  )[0];
  const flow = rows(
    db,
    `SELECT COALESCE(SUM(new_watchers), 0) AS new_watchers,
            COALESCE(SUM(churned), 0) AS churned
       FROM telegram_daily
      WHERE date BETWEEN ? AND ?`,
    [since, asOf],
  )[0];
  const usage = rows(
    db,
    `SELECT event_type, SUM(count) AS event_count
       FROM telegram_usage_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY event_type
      ORDER BY event_count DESC
      LIMIT 8`,
    [since, asOf],
  ).flatMap((row) => {
    const eventType = stringValue(row, "event_type");
    const count = numberValue(row, "event_count");
    return eventType && count !== null ? [{ eventType, count }] : [];
  });

  return {
    latestDate: latest ? stringValue(latest, "date") : null,
    subscribers: latest ? numberValue(latest, "subscribers") : null,
    activeWatchers: latest ? numberValue(latest, "active_watchers") : null,
    newWatchers: flow ? (numberValue(flow, "new_watchers") ?? 0) : 0,
    churned: flow ? (numberValue(flow, "churned") ?? 0) : 0,
    usage,
  };
}

export function loadControlCenterEvidence(path: string | null, since: string, asOf: string): ControlCenterEvidence {
  if (!path) return unavailableControlCenter(null, "Control-center database was not supplied.");
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath))
    return unavailableControlCenter(resolvedPath, "Control-center database does not exist.");

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(resolvedPath, { readOnly: true });
    const month = asOf.slice(0, 7);
    const statusRows = rows(
      db,
      `SELECT source, last_collected_at, ok, skipped, note, error
         FROM source_status
        WHERE source IN ('ga4', 'gsc', 'apikeys', 'telegram')`,
    );
    const sourceStatuses = statusRows.flatMap((row) => {
      const source = stringValue(row, "source");
      const lastCollectedAt = numberValue(row, "last_collected_at");
      if (!source || lastCollectedAt === null) return [];
      return [
        {
          source,
          lastCollectedAt,
          ok: numberValue(row, "ok") === 1,
          skipped: numberValue(row, "skipped") === 1,
          note: stringValue(row, "note"),
          error: stringValue(row, "error"),
        },
      ];
    });
    const traffic = rows(
      db,
      `SELECT period, path, pageviews, users
         FROM traffic_pages
        WHERE period IN (
          SELECT period FROM traffic_pages WHERE period <= ? GROUP BY period ORDER BY period DESC LIMIT 3
        )`,
      [month],
    ).flatMap((row) => {
      const period = stringValue(row, "period");
      const pathValue = stringValue(row, "path");
      const pageviews = numberValue(row, "pageviews");
      const users = numberValue(row, "users");
      return period && pathValue && pageviews !== null && users !== null
        ? [{ period, path: pathValue, pageviews, users }]
        : [];
    });
    const search = rows(
      db,
      `SELECT period, path, clicks, impressions
         FROM search_pages
        WHERE period IN (
          SELECT period FROM search_pages WHERE period <= ? GROUP BY period ORDER BY period DESC LIMIT 3
        )`,
      [month],
    ).flatMap((row) => {
      const period = stringValue(row, "period");
      const pathValue = stringValue(row, "path");
      const clicks = numberValue(row, "clicks");
      const impressions = numberValue(row, "impressions");
      return period && pathValue && clicks !== null && impressions !== null
        ? [{ period, path: pathValue, clicks, impressions }]
        : [];
    });
    const productEvents = rows(
      db,
      `SELECT event_name, event_count, users
         FROM product_event_totals
        WHERE period = 'rolling90' AND event_name != '__all__'`,
    ).flatMap((row) => {
      const eventName = stringValue(row, "event_name");
      const eventCount = numberValue(row, "event_count");
      const users = numberValue(row, "users");
      return eventName && eventCount !== null && users !== null ? [{ eventName, eventCount, users }] : [];
    });
    const telegram = loadTelegram(db, since, asOf);
    const warnings: string[] = [];
    const asOfEpoch = Date.parse(`${asOf}T23:59:59Z`) / 1000;
    for (const status of sourceStatuses) {
      const ageDays = Math.max(0, Math.floor((asOfEpoch - status.lastCollectedAt) / DAY_SEC));
      if (!status.ok || status.skipped) warnings.push(`${status.source} latest collection is not healthy.`);
      if (ageDays > STALE_SOURCE_DAYS)
        warnings.push(`${status.source} was last collected ${ageDays} days before as-of.`);
    }
    for (const source of ["ga4", "gsc", "apikeys", "telegram"]) {
      if (!sourceStatuses.some((status) => status.source === source))
        warnings.push(`${source} source status is unavailable.`);
    }

    return {
      available: true,
      path: resolvedPath,
      latestCollectedAt: sourceStatuses.reduce<number | null>(
        (latest, status) => (latest === null || status.lastCollectedAt > latest ? status.lastCollectedAt : latest),
        null,
      ),
      warnings,
      sourceStatuses,
      traffic,
      search,
      productEvents,
      apiRoutes: loadApiRoutes(db),
      telegram,
    };
  } catch (error) {
    return unavailableControlCenter(
      resolvedPath,
      `Control-center evidence could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    db?.close();
  }
}

function relevantSources(capability: CapabilityDefinition): string[] {
  const sources = new Set<string>();
  if (capability.routes.length > 0) {
    sources.add("ga4");
    sources.add("gsc");
  }
  if (capability.analyticsEvents.length > 0) sources.add("ga4");
  if (capability.apiRoutes.length > 0) sources.add("apikeys");
  if (capability.id === "telegram") sources.add("telegram");
  return [...sources];
}

function capabilityUsageAvailability(
  capability: CapabilityDefinition,
  controlCenter: ControlCenterEvidence,
  asOf: string,
): UsageAvailability {
  if (!controlCenter.available) return "unavailable";
  const statuses = new Map(controlCenter.sourceStatuses.map((status) => [status.source, status]));
  const asOfEpoch = Date.parse(`${asOf}T23:59:59Z`) / 1000;
  for (const source of relevantSources(capability)) {
    const status = statuses.get(source);
    if (!status || !status.ok || status.skipped || asOfEpoch - status.lastCollectedAt > STALE_SOURCE_DAYS * DAY_SEC) {
      return "partial";
    }
  }
  return "bounded";
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function buildCapabilityEvidence(
  capability: CapabilityDefinition,
  repoRoot: string,
  trackedFiles: readonly string[],
  commits: readonly GitCommitEvidence[],
  controlCenter: ControlCenterEvidence,
  asOf: string,
): CapabilityEvidence {
  const traffic = controlCenter.traffic.filter((row) =>
    capability.routes.some((route) => routeMatches(row.path, route)),
  );
  const search = controlCenter.search.filter((row) => capability.routes.some((route) => routeMatches(row.path, route)));
  const productEvents = controlCenter.productEvents.filter((row) => capability.analyticsEvents.includes(row.eventName));
  const apiRoutes = controlCenter.apiRoutes.filter((row) => capability.apiRoutes.includes(row.route));
  const usageAvailability = capabilityUsageAvailability(capability, controlCenter, asOf);
  const reviewDue = capability.decision.state === "unreviewed" || capability.decision.reviewAfter <= asOf;
  const measurementGaps: string[] = [];

  if (usageAvailability === "unavailable") measurementGaps.push("Aggregate usage evidence is unavailable.");
  if (usageAvailability === "partial")
    measurementGaps.push("One or more required usage sources are stale or unhealthy.");
  if (controlCenter.available && capability.routes.length > 0 && traffic.length === 0) {
    measurementGaps.push("No mapped route appeared in the bounded traffic sample; this is not evidence of zero use.");
  }
  if (controlCenter.available && capability.routes.length > 0 && search.length === 0) {
    measurementGaps.push("No mapped route appeared in the bounded search sample; this is not evidence of zero demand.");
  }
  const missingEvents = capability.analyticsEvents.filter(
    (eventName) => !productEvents.some((row) => row.eventName === eventName),
  );
  if (controlCenter.available && missingEvents.length > 0) {
    measurementGaps.push(
      `Mapped high-intent events not observed in the rolling90 event table: ${missingEvents.join(", ")}.`,
    );
  }
  const missingApiRoutes = capability.apiRoutes.filter((route) => !apiRoutes.some((row) => row.route === route));
  if (controlCenter.available && missingApiRoutes.length > 0) {
    measurementGaps.push(
      `Mapped API routes not observed in the bounded top-routes sample: ${missingApiRoutes.join(", ")}.`,
    );
  }

  const attentionReasons: string[] = [];
  if (capability.decision.state === "unreviewed") attentionReasons.push("initial owner review pending");
  else if (reviewDue) attentionReasons.push("review date reached");
  if (capability.decision.state === "incubating" && reviewDue) attentionReasons.push("incubation evaluation due");
  if (usageAvailability === "unavailable") attentionReasons.push("usage evidence unavailable");
  else if (usageAvailability === "partial") attentionReasons.push("usage evidence partial");

  return {
    capability,
    reviewDue,
    usageAvailability,
    traffic,
    search,
    productEvents,
    apiRoutes,
    telegram: capability.id === "telegram" ? controlCenter.telegram : null,
    footprint: collectRepositoryFootprint(repoRoot, trackedFiles, capability.codePaths),
    activity: collectGitActivity(commits, capability.codePaths),
    measurementGaps: unique(measurementGaps),
    attentionReasons: unique(attentionReasons),
  };
}

export function buildCapabilityReviewReport(args: {
  repoRoot: string;
  registry: readonly CapabilityDefinition[];
  trackedFiles: readonly string[];
  commits: readonly GitCommitEvidence[];
  controlCenter: ControlCenterEvidence;
  asOf: string;
  since: string;
}): CapabilityReviewReport {
  return {
    asOf: args.asOf,
    since: args.since,
    controlCenter: args.controlCenter,
    capabilities: args.registry.map((capability) =>
      buildCapabilityEvidence(
        capability,
        args.repoRoot,
        args.trackedFiles,
        args.commits,
        args.controlCenter,
        args.asOf,
      ),
    ),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatOptionalNumber(value: number | null): string {
  return value === null ? "unavailable" : formatNumber(value);
}

export function escapeCapabilityReviewTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function formatEpoch(value: number | null): string {
  return value === null ? "unavailable" : new Date(value * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function aggregateTraffic(rowsValue: readonly TrafficEvidenceRow[]): Array<{
  path: string;
  pageviews: number;
  latestPeriod: string;
  latestUsers: number;
}> {
  const grouped = new Map<string, { pageviews: number; latestPeriod: string; latestUsers: number }>();
  for (const row of rowsValue) {
    const current = grouped.get(row.path);
    if (!current) {
      grouped.set(row.path, { pageviews: row.pageviews, latestPeriod: row.period, latestUsers: row.users });
    } else {
      current.pageviews += row.pageviews;
      if (row.period > current.latestPeriod) {
        current.latestPeriod = row.period;
        current.latestUsers = row.users;
      }
    }
  }
  return [...grouped.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort((left, right) => right.pageviews - left.pageviews || left.path.localeCompare(right.path));
}

function trafficSummary(evidence: CapabilityEvidence): string {
  if (evidence.usageAvailability === "unavailable") return "unavailable";
  const rowsValue = aggregateTraffic(evidence.traffic);
  if (rowsValue.length === 0) return "not observed in bounded sample";
  const views = rowsValue.reduce((sum, row) => sum + row.pageviews, 0);
  return `${formatNumber(views)} views / ${rowsValue.length} sampled path${rowsValue.length === 1 ? "" : "s"}`;
}

function searchSummary(evidence: CapabilityEvidence): string {
  if (evidence.usageAvailability === "unavailable") return "unavailable";
  if (evidence.search.length === 0) return "not observed in bounded sample";
  const clicks = evidence.search.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = evidence.search.reduce((sum, row) => sum + row.impressions, 0);
  return `${formatNumber(clicks)} clicks / ${formatNumber(impressions)} impr.`;
}

function eventSummary(evidence: CapabilityEvidence): string {
  if (evidence.capability.analyticsEvents.length === 0) return "not mapped";
  if (evidence.usageAvailability === "unavailable") return "unavailable";
  if (evidence.productEvents.length === 0) return "not observed";
  return evidence.productEvents
    .slice()
    .sort((left, right) => right.eventCount - left.eventCount)
    .map((row) => `${row.eventName}: ${formatNumber(row.eventCount)} / ${formatNumber(row.users)} users`)
    .join("; ");
}

function apiSummary(evidence: CapabilityEvidence): string {
  if (evidence.capability.apiRoutes.length === 0) return "not mapped";
  if (evidence.usageAvailability === "unavailable") return "unavailable";
  if (evidence.apiRoutes.length === 0) return "not observed in bounded sample";
  const requests = evidence.apiRoutes.reduce((sum, row) => sum + row.requests, 0);
  return `${formatNumber(requests)} requests / ${evidence.apiRoutes.length} top route${evidence.apiRoutes.length === 1 ? "" : "s"}`;
}

function sampledPathSummary(evidence: CapabilityEvidence): string | null {
  const sampled = aggregateTraffic(evidence.traffic).slice(0, 3);
  if (sampled.length === 0) return null;
  return sampled
    .map(
      (row) =>
        `${row.path}: ${formatNumber(row.pageviews)} views / ${formatNumber(row.latestUsers)} users (${row.latestPeriod})`,
    )
    .join("; ");
}

function renderCapabilityDetails(evidence: CapabilityEvidence): string[] {
  const lines = [
    `### ${evidence.capability.name}`,
    "",
    evidence.capability.purpose,
    "",
    `- **Strategy:** ${evidence.capability.strategicRationale}`,
    `- **Decision:** ${evidence.capability.decision.state}; ${evidence.capability.decision.rationale} Review ${evidence.capability.decision.reviewedAt ?? "not yet completed"}; next ${evidence.capability.decision.reviewAfter}.`,
    `- **Usage (${evidence.usageAvailability}):** web ${trafficSummary(evidence)}; search ${searchSummary(evidence)}; actions ${eventSummary(evidence)}; API ${apiSummary(evidence)}.`,
  ];

  const sampledPaths = sampledPathSummary(evidence);
  if (sampledPaths)
    lines.push(`- **Top sampled paths:** ${sampledPaths}. Monthly users are per path and are not additive.`);

  if (evidence.telegram) {
    lines.push(
      `- **Telegram (${evidence.telegram.latestDate ?? "unavailable"}):** ${formatOptionalNumber(evidence.telegram.activeWatchers)} active watchers; ${formatOptionalNumber(evidence.telegram.subscribers)} subscribers; window flows ${formatNumber(evidence.telegram.newWatchers)} new / ${formatNumber(evidence.telegram.churned)} churned.`,
    );
    if (evidence.telegram.usage.length > 0) {
      lines.push(
        `- **Telegram top usage:** ${evidence.telegram.usage
          .slice(0, 5)
          .map((row) => `${row.eventType} ${formatNumber(row.count)}`)
          .join("; ")}.`,
      );
    }
  }

  lines.push(
    `- **Repository:** ${formatNumber(evidence.footprint.sourceFiles)} source files; ${formatNumber(evidence.footprint.testFiles)} tests; approximately ${formatNumber(evidence.footprint.approximateLoc)} authored LOC; ${evidence.capability.cronJobs.length} jobs. Counts are non-exclusive.`,
    `- **Activity:** ${formatNumber(evidence.activity.commits)} commits, including ${formatNumber(evidence.activity.fixes)} \`fix\` commits.`,
  );
  if (evidence.activity.recentSubjects.length > 0) {
    lines.push(
      `- **Recent subjects:** ${evidence.activity.recentSubjects
        .slice(0, 3)
        .map((subject) => `\`${subject.replace(/`/g, "'")}\``)
        .join("; ")}.`,
    );
  }

  if (evidence.measurementGaps.length > 0) {
    lines.push(`- **Measurement gaps:** ${evidence.measurementGaps.join(" ")}`);
  }

  lines.push("", "**Review:** Proposed state: | Why: | Evidence still missing: | Next review date:", "");
  return lines;
}

export function renderCapabilityReview(report: CapabilityReviewReport): string {
  const lines = [
    `# Capability Lifecycle Review - ${report.asOf}`,
    "",
    `Git activity window: ${report.since} through ${report.asOf}.`,
    `Control-center evidence: ${report.controlCenter.path ?? "not supplied"}.`,
    `Latest aggregate collection: ${formatEpoch(report.controlCenter.latestCollectedAt)}.`,
    "",
    "## Evidence limits",
    "",
    "- Traffic and search totals cover their three latest stored periods and are bounded top-page samples, not exhaustive route logs.",
    `- Product events use the stored rolling90 aggregate; Telegram flows and usage cover ${report.since} through ${report.asOf}.`,
    "- Monthly users are not additive across paths or months.",
    "- Users from separate analytics events are not added together.",
    "- API route evidence is the latest stored bounded top-routes snapshot; absence never means zero usage.",
    "- Repository footprint is approximate and non-exclusive; activity can represent investment or burden.",
  ];
  for (const warning of report.controlCenter.warnings) lines.push(`- Warning: ${warning}`);

  const attention = report.capabilities.filter((item) => item.attentionReasons.length > 0);
  lines.push("", "## Review queue", "");
  if (attention.length === 0) lines.push("No deterministic attention flags.");
  else {
    for (const item of attention) {
      lines.push(`- **${item.capability.name}:** ${item.attentionReasons.join("; ")}.`);
    }
  }

  lines.push(
    "",
    "Review at most three capabilities in the first owner session. The generator does not recommend a lifecycle state.",
    "",
    "## Portfolio",
    "",
    "| Capability | State | Web usage | Search | High-intent actions (rolling90) | API | Files/tests/LOC | Commits/fixes | Jobs | Review due |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- |",
  );
  for (const item of report.capabilities) {
    lines.push(
      `| ${escapeCapabilityReviewTableCell(item.capability.name)} | ${item.capability.decision.state} | ${escapeCapabilityReviewTableCell(trafficSummary(item))} | ${escapeCapabilityReviewTableCell(searchSummary(item))} | ${escapeCapabilityReviewTableCell(eventSummary(item))} | ${escapeCapabilityReviewTableCell(apiSummary(item))} | ${formatNumber(item.footprint.sourceFiles)}/${formatNumber(item.footprint.testFiles)}/${formatNumber(item.footprint.approximateLoc)} | ${formatNumber(item.activity.commits)}/${formatNumber(item.activity.fixes)} | ${item.capability.cronJobs.length} | ${item.reviewDue ? "yes" : "no"} |`,
    );
  }

  lines.push("", "## Capability evidence", "");
  for (const item of report.capabilities) lines.push(...renderCapabilityDetails(item));
  return `${lines.join("\n").trim()}\n`;
}

export function generateCapabilityReview(args: {
  repoRoot: string;
  registry?: readonly CapabilityDefinition[];
  asOf: string;
  since: string;
  controlCenterDbPath: string | null;
}): { report: CapabilityReviewReport; markdown: string } {
  const registry = args.registry ?? CAPABILITY_REGISTRY;
  const validationErrors = validateCapabilityRegistry(registry, args.repoRoot);
  if (validationErrors.length > 0) {
    throw new Error(`Capability registry validation failed:\n- ${validationErrors.join("\n- ")}`);
  }
  const report = buildCapabilityReviewReport({
    repoRoot: args.repoRoot,
    registry,
    trackedFiles: gitTrackedFiles(args.repoRoot),
    commits: gitActivity(args.repoRoot, args.since, args.asOf),
    controlCenter: loadControlCenterEvidence(args.controlCenterDbPath, args.since, args.asOf),
    asOf: args.asOf,
    since: args.since,
  });
  return { report, markdown: renderCapabilityReview(report) };
}

function main(): void {
  const options = parseCliArgs(process.argv.slice(2));
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const { markdown } = generateCapabilityReview({
    repoRoot,
    asOf: options.asOf,
    since: options.since,
    controlCenterDbPath: options.controlCenterDbPath,
  });
  process.stdout.write(markdown);
  if (options.write) {
    const agentsDir = resolve(repoRoot, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const outputPath = resolve(agentsDir, `capability-review-${options.asOf}.md`);
    writeFileSync(outputPath, markdown, "utf8");
    process.stderr.write(`Wrote ${outputPath}\n`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export type { CapabilityDefinition, CapabilityState };
