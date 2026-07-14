/**
 * Fetches confirmed depeg events from an explicit API base/URL and writes them
 * to data/depeg-events.json keyed by deterministic slug. Run before builds so
 * the /depeg/[event]/ static-export route can call generateStaticParams() from
 * the committed snapshot.
 *
 * Mirrors scripts/maintenance/sync-digests.ts.
 *
 *   DEPEG_EVENTS_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-depeg-events.ts
 *   # or
 *   tsx scripts/maintenance/sync-depeg-events.ts --api-url https://api.pharos.watch
 */

import type { DepegEvent } from "@shared/types/market";
import { formatIsoDate } from "@shared/lib/format";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseStrictCliArgs,
  runCliEntrypoint,
  writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { apiFetchHeaders, fetchWithRetry, resolveApiUrl, syncJson } from "../lib/sync-from-api";

const USAGE = `Usage: npx tsx scripts/maintenance/sync-depeg-events.ts [options]

Options:
  --api-url <url>   Depeg API base or endpoint (overrides environment)
  --output <path>   Output path (default: data/depeg-events.json)
  --allow-empty     Permit an empty response to replace a non-empty snapshot
  --dry-run         Fetch and validate without writing the output file
  -h, --help        Show this help`;

interface DepegEventsResponse {
  events: DepegEvent[];
  total?: number;
  nextCursor?: string | null;
}

interface DepegEventEntry extends DepegEvent {
  slug: string;
}

export interface DepegSyncCliOptions {
  allowEmpty: boolean;
  apiUrl: string | null;
  dryRun: boolean;
  help: boolean;
  output: string | null;
}

export function parseDepegSyncArgs(argv: string[]): DepegSyncCliOptions {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "allow-empty": { type: "boolean" },
      "api-url": { type: "string" },
      "dry-run": { type: "boolean" },
      output: { type: "string" },
    },
  });
  return {
    allowEmpty: values["allow-empty"] === true,
    apiUrl: typeof values["api-url"] === "string" ? values["api-url"] : null,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
    output: typeof values.output === "string" ? values.output : null,
  };
}

function symbolToSlugPart(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function baseSlug(event: DepegEvent): string {
  const sanitized = symbolToSlugPart(event.symbol);
  const symbolPart = sanitized.length > 0 ? sanitized : event.stablecoinId;
  return `${symbolPart}-${formatIsoDate(event.startedAt)}`;
}

function resolveOutputPath(explicit: string | null): URL {
  if (!explicit) return new URL("../../data/depeg-events.json", import.meta.url);
  return new URL(explicit, `file://${process.cwd()}/`);
}

/**
 * Resolve slug collisions deterministically. If two events for the same coin
 * share a day, append `-up`/`-down` from `direction`. Stable across rebuilds
 * because input order is sorted by `startedAt DESC, id DESC`.
 */
export function assignSlugs(events: readonly DepegEvent[]): DepegEventEntry[] {
  const byBase = new Map<string, DepegEvent[]>();
  for (const event of events) {
    const key = baseSlug(event);
    const bucket = byBase.get(key);
    if (bucket) bucket.push(event);
    else byBase.set(key, [event]);
  }

  const result: DepegEventEntry[] = [];
  for (const event of events) {
    const key = baseSlug(event);
    const bucket = byBase.get(key) ?? [event];
    if (bucket.length === 1) {
      result.push({ ...event, slug: key });
      continue;
    }
    // Same-day collisions: append direction. If still colliding (very rare —
    // multiple events on same coin/day/direction), append id for stability.
    const directionSuffix = event.direction === "above" ? "up" : "down";
    let candidate = `${key}-${directionSuffix}`;
    const sameDirectionCount = bucket.filter((e) => e.direction === event.direction).length;
    if (sameDirectionCount > 1) {
      candidate = `${candidate}-${event.id}`;
    }
    result.push({ ...event, slug: candidate });
  }
  return result;
}

export async function runDepegSync(argv = process.argv.slice(2)) {
  const options = parseDepegSyncArgs(argv);
  if (writeCliHelpIfRequested(options, USAGE)) return;

  const apiUrl = resolveApiUrl({
    argName: "--api-url",
    explicitUrl: options.apiUrl,
    envNames: ["DEPEG_EVENTS_API_URL", "SMOKE_API_BASE", "API_BASE_URL"],
    apiPath: "/api/depeg-events",
    scriptName: "sync-depeg-events",
  });
  const outputPath = resolveOutputPath(options.output);
  const headers = new Headers(apiFetchHeaders(["DEPEG_EVENTS_API_KEY", "SMOKE_API_KEY"]));

  console.log(`[sync-depeg-events] Source: ${apiUrl}`);

  const { entries, outputFile, written } = await syncJson<DepegEventEntry>({
    writeTo: outputPath,
    parse: async () => {
      const collected: DepegEvent[] = [];
      let cursor: string | null = null;
      const limit = 1000;
      const maxPages = 20; // hard ceiling so we cannot loop forever
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        const pagedUrl = `${apiUrl}?${params.toString()}`;
        const res = await fetchWithRetry(pagedUrl, { headers }, {
          logLabel: "sync-depeg-events",
          retryStatuses: [403],
          backoffMs: [12_000, 12_000],
        });
        if (!res.ok) throw new Error(`API returned ${res.status} for ${pagedUrl}`);
        const body = (await res.json()) as DepegEventsResponse;
        const batch = Array.isArray(body.events) ? body.events : [];
        collected.push(...batch);
        cursor = body.nextCursor ?? null;
        console.log(
          `[sync-depeg-events] page=${page} fetched=${batch.length} total=${collected.length} cursor=${cursor ?? "null"}`,
        );
        if (!cursor || batch.length === 0) break;
      }

      // v1: confirmed events only (pending/expired/rejected do not get permanent URLs).
      // The /api/depeg-events handler already excludes pending unless includePending=true.
      // Do not filter on pendingReason here: confirmed events can retain that field
      // as provenance for how they entered confirmation.
      const confirmed = [...collected];

      // Deduplicate on event id (defensive in case pagination yields overlap).
      const seen = new Set<number>();
      const unique: DepegEvent[] = [];
      for (const event of confirmed) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        unique.push(event);
      }

      unique.sort((a, b) => {
        if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
        return b.id - a.id;
      });

      const computedEntries = assignSlugs(unique);

      // Guard against API returning an empty list (e.g. token expiry, partial
      // outage, or a misconfigured API base). Wiping the seed event would purge
      // every /depeg/<slug>/ static page on the next build and invalidate the
      // depeg RSS feed for downstream subscribers. Treat empty + non-empty
      // existing file as a hard error rather than a silent overwrite.
      if (computedEntries.length === 0) {
        const existingFile = fileURLToPath(outputPath);
        if (existsSync(existingFile)) {
          let previous: unknown;
          try {
            previous = JSON.parse(readFileSync(existingFile, "utf8"));
          } catch {
            previous = null;
          }
          if (Array.isArray(previous) && previous.length > 0) {
            console.error(
              `[sync-depeg-events] API returned 0 events but ${existingFile} currently holds ${previous.length}. ` +
                `Refusing to overwrite — pass --allow-empty to override (e.g. when the API is intentionally drained).`,
            );
            if (!options.allowEmpty) throw new Error("Refusing to replace a non-empty depeg snapshot with an empty response");
          }
        }
      }

      return computedEntries;
    },
    write: !options.dryRun,
  });
  console.log(
    written
      ? `[sync-depeg-events] Wrote ${entries.length} confirmed events to ${outputFile}`
      : `[sync-depeg-events] Dry run: would write ${entries.length} confirmed events to ${outputFile}`,
  );
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runDepegSync(), { label: "sync-depeg-events", usage: USAGE });
}
