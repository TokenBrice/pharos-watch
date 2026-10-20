/**
 * Fetches confirmed depeg events from an explicit API base/URL and writes them
 * to data/depeg-events/index.json plus UTC-year shards. Run before builds so
 * the /depeg/[event]/ static-export route can call generateStaticParams() from
 * the committed snapshot.
 *
 * Mirrors scripts/maintenance/sync-digests.ts.
 *
 *   DEPEG_EVENTS_API_URL=https://ops-api.example.com tsx scripts/maintenance/sync-depeg-events.ts
 *   # or
 *   tsx scripts/maintenance/sync-depeg-events.ts --api-url https://api.pharos.watch
 */

import {
  DepegEventStoredSnapshotSchema,
  DepegEventsResponseSchema,
  type DepegEvent,
  type DepegEventEntry,
} from "@shared/types/market";
import { formatIsoDate } from "@shared/lib/format";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDedicatedDepegEventPage, selectStaticDepegEventPages } from "@/lib/depeg-event-config";

import { parseStrictCliArgs, runCliEntrypoint, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { isDirectRun } from "../lib/smoke-runtime.mjs";
import { DEPEG_LEDGER_CAPTURE_RELATIVE_PATH, depegLedgerCaptureId, type DepegLedgerCapture } from "../lib/depeg-ledger-capture";
import {
  apiFetchHeaders,
  fetchWithRetry,
  resolveApiUrl,
  shouldAllowExistingDataOnFetchFailure,
  SnapshotIntegrityError,
} from "../lib/sync-from-api";

const USAGE = `Usage: npx tsx scripts/maintenance/sync-depeg-events.ts [options]

Options:
  --api-url <url>   Depeg API base or endpoint (overrides environment)
  --output <path>   Index output path (default: data/depeg-events/index.json)
  --allow-empty     Permit an empty response to replace a non-empty snapshot
  --allow-archive-shrink
                   Permit published depeg page slugs to disappear from the snapshot
  --allow-existing-on-fetch-failure
                   Preserve a valid existing output file if the live fetch fails
  --dry-run         Fetch and validate without writing the output file
  -h, --help        Show this help`;

// Legacy captures can omit total; supplied totals and cursors must still be valid.
const DepegSyncResponseSchema = DepegEventsResponseSchema.extend({
  total: DepegEventsResponseSchema.shape.total.int().nonnegative().safe().optional(),
  nextCursor: DepegEventsResponseSchema.shape.nextCursor.unwrap().unwrap().min(1).nullable().optional(),
});

const MAX_DEPEG_SYNC_PAGES = 1000;

export interface DepegSyncCliOptions {
  allowArchiveShrink: boolean;
  allowEmpty: boolean;
  allowExistingOnFetchFailure: boolean;
  apiUrl: string | null;
  dryRun: boolean;
  help: boolean;
  output: string | null;
}

export function parseDepegSyncArgs(argv: string[]): DepegSyncCliOptions {
  const { values } = parseStrictCliArgs(argv, {
    options: {
      "allow-archive-shrink": { type: "boolean" },
      "allow-empty": { type: "boolean" },
      "allow-existing-on-fetch-failure": { type: "boolean" },
      "api-url": { type: "string" },
      "dry-run": { type: "boolean" },
      output: { type: "string" },
    },
  });
  return {
    allowArchiveShrink: values["allow-archive-shrink"] === true,
    allowEmpty: values["allow-empty"] === true,
    allowExistingOnFetchFailure: values["allow-existing-on-fetch-failure"] === true,
    apiUrl: typeof values["api-url"] === "string" ? values["api-url"] : null,
    dryRun: values["dry-run"] === true,
    help: values.help === true,
    output: typeof values.output === "string" ? values.output : null,
  };
}

interface DepegEventOutputPaths {
  dataDir: string;
  indexFile: string;
}

function readExistingDepegEntries(dataDir: string): readonly DepegEventEntry[] {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir)
    .filter((name) => /^\d{4}\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const path = `${dataDir}/${name}`;
      return DepegEventStoredSnapshotSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    });
}

export function findMissingStaticDepegArchiveSlugs(
  previous: readonly DepegEventEntry[],
  current: readonly DepegEventEntry[],
): string[] {
  const currentSlugs = new Set(selectStaticDepegEventPages(current).map((event) => event.slug));
  return selectStaticDepegEventPages(previous)
    .map((event) => event.slug)
    .filter((slug) => !currentSlugs.has(slug));
}

/**
 * Keep a published page when the live event is later reclassified below the
 * static-page threshold. The archive is grow-only, so the older published row
 * remains the source for that URL while the current API projection continues
 * to describe the event in the live tracker.
 */
export function preserveStaticDepegArchiveEntries(
  previous: readonly DepegEventEntry[],
  current: readonly DepegEventEntry[],
): DepegEventEntry[] {
  const mergedBySlug = new Map(current.map((entry) => [entry.slug, entry] as const));

  for (const previousEntry of selectStaticDepegEventPages(previous)) {
    const currentEntry = mergedBySlug.get(previousEntry.slug);
    if (currentEntry == null || hasDedicatedDepegEventPage(currentEntry)) continue;
    mergedBySlug.set(previousEntry.slug, previousEntry);
  }

  return [...mergedBySlug.values()].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return b.id - a.id;
  });
}

export function assertStaticDepegArchivePreserved(
  previous: readonly DepegEventEntry[],
  current: readonly DepegEventEntry[],
  allowShrink = false,
): void {
  const missing = findMissingStaticDepegArchiveSlugs(previous, current);
  if (missing.length === 0) return;
  const sample = missing.slice(0, 10).join(", ");
  const suffix = missing.length > 10 ? ` (+${missing.length - 10} more)` : "";
  const message = `Depeg static archive lost ${missing.length} published slug(s): ${sample}${suffix}`;
  if (!allowShrink) {
    throw new SnapshotIntegrityError(`${message}. Pass --allow-archive-shrink only for an explicitly reviewed removal.`);
  }
  console.warn(`[sync-depeg-events] WARNING: ${message}`);
}

function symbolToSlugPart(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function baseSlug(event: DepegEvent): string {
  const sanitized = symbolToSlugPart(event.symbol);
  const symbolPart = sanitized.length > 0 ? sanitized : event.stablecoinId;
  return `${symbolPart}-${formatIsoDate(event.startedAt)}`;
}

function resolveOutputPaths(explicit: string | null): DepegEventOutputPaths {
  const indexUrl = explicit
    ? new URL(explicit, `file://${process.cwd()}/`)
    : new URL("../../data/depeg-events/index.json", import.meta.url);
  const indexFile = fileURLToPath(indexUrl);
  return { dataDir: dirname(indexFile), indexFile };
}

function buildDepegEventIndex(entries: readonly DepegEventEntry[]) {
  return selectStaticDepegEventPages(entries).map((event) => ({
    slug: event.slug,
    stablecoinId: event.stablecoinId,
    symbol: event.symbol,
    pegType: event.pegType,
    direction: event.direction,
    peakDeviationBps: event.peakDeviationBps,
    startedAt: event.startedAt,
  }));
}

function writeDepegEventLedger(
  entries: readonly DepegEventEntry[],
  paths: DepegEventOutputPaths,
): { shardCount: number } {
  const shards = new Map<string, DepegEventEntry[]>();
  for (const entry of entries) {
    const year = String(new Date(entry.startedAt * 1000).getUTCFullYear());
    const shard = shards.get(year);
    if (shard) shard.push(entry);
    else shards.set(year, [entry]);
  }

  mkdirSync(paths.dataDir, { recursive: true });
  const expectedShardNames = new Set<string>();
  for (const year of [...shards.keys()].sort()) {
    const name = `${year}.json`;
    expectedShardNames.add(name);
    writeFileSync(`${paths.dataDir}/${name}`, `${JSON.stringify(shards.get(year), null, 2)}\n`);
  }
  for (const name of readdirSync(paths.dataDir)) {
    if (/^\d{4}\.json$/.test(name) && !expectedShardNames.has(name)) {
      rmSync(`${paths.dataDir}/${name}`);
    }
  }

  writeFileSync(paths.indexFile, `${JSON.stringify(buildDepegEventIndex(entries), null, 2)}\n`);
  return { shardCount: shards.size };
}

/**
 * Reserve historical URLs by durable event ID before naming newcomers. Missing
 * IDs keep their slugs reserved so a newcomer cannot conceal an archive deletion.
 */
export function assignSlugs(
  events: readonly DepegEvent[],
  previous: readonly DepegEventEntry[] = [],
): DepegEventEntry[] {
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  const reserved = new Set(previous.map((entry) => entry.slug));
  const byBase = new Map<string, DepegEvent[]>();
  for (const event of events) {
    const key = baseSlug(event);
    const bucket = byBase.get(key);
    if (bucket) bucket.push(event);
    else byBase.set(key, [event]);
  }

  return events.map((event) => {
    const prior = previousById.get(event.id);
    if (prior) {
      if (prior.stablecoinId !== event.stablecoinId) {
        throw new SnapshotIntegrityError(`Depeg event ${event.id} changed stablecoin identity; review the archive migration`);
      }
      return { ...event, slug: prior.slug };
    }
    const key = baseSlug(event);
    const bucket = byBase.get(key) ?? [event];
    const directionSuffix = event.direction === "above" ? "up" : "down";
    let candidate = key;
    if (bucket.length > 1 || reserved.has(candidate)) {
      candidate = `${key}-${directionSuffix}`;
      if (bucket.filter((entry) => entry.direction === event.direction).length > 1 || reserved.has(candidate)) {
        candidate = `${candidate}-${event.id}`;
      }
    }
    while (reserved.has(candidate)) candidate = `${candidate}-${event.id}`;
    reserved.add(candidate);
    return { ...event, slug: candidate };
  });
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
  const outputPaths = resolveOutputPaths(options.output);
  const previousEntries = readExistingDepegEntries(outputPaths.dataDir);
  const headers = new Headers(apiFetchHeaders(["DEPEG_EVENTS_API_KEY", "SMOKE_API_KEY"], { url: apiUrl }));

  console.log(`[sync-depeg-events] Source: ${apiUrl}`);

  try {
    const observationStartedAtISO = new Date().toISOString();
    const { entries, apiTotal } = await (async () => {
      const collected: DepegEvent[] = [];
      let cursor: string | null = null;
      let expectedTotal: number | undefined;
      const limit = 1000;
      const maxPages = MAX_DEPEG_SYNC_PAGES; // safety ceiling, never a successful partial ledger
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (cursor) params.set("cursor", cursor);
        const pagedUrl = `${apiUrl}?${params.toString()}`;
        const res = await fetchWithRetry(
          pagedUrl,
          { headers },
          {
            logLabel: "sync-depeg-events",
            retryStatuses: [403],
            backoffMs: [12_000, 12_000],
          },
        );
        if (!res.ok) throw new Error(`API returned ${res.status} for ${pagedUrl}`);
        let payload: unknown;
        try {
          payload = await res.json();
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new SnapshotIntegrityError("Invalid depeg response: malformed JSON");
          }
          throw error;
        }
        const parsed = DepegSyncResponseSchema.safeParse(payload);
        if (!parsed.success) {
          throw new SnapshotIntegrityError(`Invalid depeg response: ${parsed.error.message}`);
        }
        const body = parsed.data;
        if (page === 0) expectedTotal = body.total;
        else if (body.total !== expectedTotal) {
          throw new SnapshotIntegrityError("Depeg pagination changed its API total during traversal");
        }
        const batch = body.events;
        collected.push(...batch);
        cursor = body.nextCursor ?? null;
        console.log(
          `[sync-depeg-events] page=${page} fetched=${batch.length} total=${collected.length} cursor=${cursor ?? "null"}`,
        );
        if (!cursor) break;
        if (batch.length === 0) {
          throw new SnapshotIntegrityError("Depeg pagination returned an empty page with an outstanding cursor");
        }
      }
      if (cursor) {
        throw new SnapshotIntegrityError(
          `Depeg pagination reached its ${maxPages}-page safety ceiling with an outstanding cursor; refusing an incomplete ledger`,
        );
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
      if (expectedTotal !== undefined && unique.length !== expectedTotal) {
        throw new SnapshotIntegrityError(
          `Depeg pagination collected ${unique.length} unique events but the API reported ${expectedTotal}; refusing an incomplete ledger`,
        );
      }

      unique.sort((a, b) => {
        if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
        return b.id - a.id;
      });

      const computedEntries = assignSlugs(unique, previousEntries);
      const stored = DepegEventStoredSnapshotSchema.safeParse(
        preserveStaticDepegArchiveEntries(previousEntries, computedEntries),
      );
      if (!stored.success) {
        throw new SnapshotIntegrityError(`Invalid stored depeg snapshot: ${stored.error.message}`);
      }
      const archivePreservedEntries = stored.data;

      // Guard against API returning an empty list (e.g. token expiry, partial
      // outage, or a misconfigured API base). Wiping the seed event would purge
      // every /depeg/<slug>/ static page on the next build and invalidate the
      // depeg RSS feed for downstream subscribers. Treat empty + non-empty
      // existing file as a hard error rather than a silent overwrite.
      if (computedEntries.length === 0) {
        if (previousEntries.length > 0) {
          console.error(
            `[sync-depeg-events] API returned 0 events but ${outputPaths.dataDir} currently holds ${previousEntries.length} events. ` +
              `Refusing to overwrite — pass --allow-empty to override (e.g. when the API is intentionally drained).`,
          );
          if (!options.allowEmpty)
            throw new SnapshotIntegrityError(
              "Refusing to replace a non-empty depeg snapshot with an empty response",
            );
        }
      }

      assertStaticDepegArchivePreserved(
        previousEntries,
        archivePreservedEntries,
        options.allowArchiveShrink,
      );
      return { entries: archivePreservedEntries, apiTotal: expectedTotal ?? null };
    })();
    const shardCount = new Set(
      entries.map((entry) => String(new Date(entry.startedAt * 1000).getUTCFullYear())),
    ).size;
    if (!options.dryRun) {
      writeDepegEventLedger(entries, outputPaths);
      const capture: DepegLedgerCapture = {
        schemaVersion: 1,
        captureId: depegLedgerCaptureId(outputPaths.dataDir),
        observationStartedAtISO,
        observedAtISO: new Date().toISOString(),
        sourceUrl: apiUrl,
        methodologyVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
        eventCount: entries.length,
        apiTotal,
      };
      const capturePath = `${outputPaths.dataDir}/${DEPEG_LEDGER_CAPTURE_RELATIVE_PATH}`;
      mkdirSync(dirname(capturePath), { recursive: true });
      writeFileSync(capturePath, `${JSON.stringify(capture, null, 2)}\n`);
      rmSync(`${outputPaths.dataDir}/capture.json`, { force: true });
    }
    console.log(
      options.dryRun
        ? `[sync-depeg-events] Dry run: would write ${entries.length} confirmed events to ${outputPaths.indexFile} and ${shardCount} yearly shards`
        : `[sync-depeg-events] Wrote ${entries.length} confirmed events to ${outputPaths.indexFile} and ${shardCount} yearly shards`,
    );
  } catch (err) {
    // Integrity guards are deterministic, so the fetch-failure fallback must not relabel them.
    if (err instanceof SnapshotIntegrityError) throw err;
    const allowExisting =
      options.allowExistingOnFetchFailure ||
      shouldAllowExistingDataOnFetchFailure(["DEPEG_EVENTS_SYNC_ALLOW_EXISTING_ON_FETCH_FAILURE"]);
    if (allowExisting && !options.dryRun && previousEntries.length > 0) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sync-depeg-events] Live fetch failed (${reason}); preserving existing ${outputPaths.dataDir} (${previousEntries.length} events).`,
      );
      return;
    }
    throw err;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  void runCliEntrypoint(() => runDepegSync(), { label: "sync-depeg-events", usage: USAGE });
}
