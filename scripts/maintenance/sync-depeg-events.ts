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
} from "@shared/types/peg";
import { formatIsoDate } from "@shared/lib/format";
import { SITE_API_ORIGIN } from "@shared/lib/runtime-origins";
import { DEPEG_LEDGER_PAGE_SIZE } from "@shared/types/depeg-event-projection";
import { DdrResponseSchema, DdrV2BaseRowSchema, DdrV2LiveOverlaySchema } from "@shared/types/depeg-resolver";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { hasDedicatedDepegEventPage, selectStaticDepegEventPages } from "@/lib/depeg-event-config";
import { hasReviewedDepegEvent, readDepegEventIndex, readDepegEventSnapshot, resolveRetainedDepegEventPage } from "@/lib/depeg-event-snapshot";

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

// Only the public incident identity and live representative are needed here.
const DepegArchiveLineageSchema = DdrResponseSchema.pick({ rows: true }).extend({
  rows: DdrV2BaseRowSchema.pick({
    eventId: true,
    incidentKey: true,
    stablecoinId: true,
    direction: true,
  }).extend({
    live: DdrV2LiveOverlaySchema.pick({ currentEventId: true, eventState: true }),
  }).array(),
});
type DepegArchiveLineage = z.infer<typeof DepegArchiveLineageSchema>["rows"];

const MAX_DEPEG_SYNC_PAGES = 1000;
const SITE_API_DEPEG_SYNC_LIMIT = 5000;

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

export function findMissingStaticDepegArchiveSlugs(
  previousPages: readonly DepegEventEntry[],
  currentPages: readonly DepegEventEntry[],
): string[] {
  const currentSlugs = new Set(currentPages.map((event) => event.slug));
  return previousPages
    .map((event) => event.slug)
    .filter((slug) => !currentSlugs.has(slug));
}

/**
 * Keep a published page when the live event is reclassified below the static-page
 * threshold, or verified public incident lineage identifies its present replacement.
 * Keep the latest reviewed row at its reserved URL. Unexplained disappearances
 * still reach the guard.
 */
export function preserveStaticDepegArchiveEntries(
  previousPages: readonly DepegEventEntry[],
  current: readonly DepegEventEntry[],
  lineage: readonly DepegArchiveLineage[number][] = [],
): DepegEventEntry[] {
  const pagesBySlug = new Map(selectStaticDepegEventPages(current).map((entry) => [entry.slug, entry] as const));
  const currentBySlug = new Map(current.map((entry) => [entry.slug, entry] as const));
  const representativesById = new Map(current.map((entry) => [entry.id, entry] as const));
  const replacementById = new Map(lineage.map((row) => [row.eventId, row] as const));

  for (const previousEntry of previousPages) {
    const currentEntry = currentBySlug.get(previousEntry.slug);
    if (currentEntry == null) {
      const incident = replacementById.get(previousEntry.id);
      const representative = incident?.live.currentEventId == null
        ? undefined
        : representativesById.get(incident.live.currentEventId);
      const reasons: string[] = [];
      if (!incident) reasons.push("incident-not-found");
      else {
        if (incident.incidentKey.length === 0) reasons.push("empty-incident-key");
        if (incident.live.eventState !== "active") reasons.push("incident-not-active");
        if (incident.stablecoinId !== previousEntry.stablecoinId) reasons.push("incident-coin-mismatch");
        if (incident.direction !== previousEntry.direction) reasons.push("incident-direction-mismatch");
        if (!representative) reasons.push("representative-not-in-ledger");
        else {
          if (representative.id === previousEntry.id) reasons.push("representative-not-replaced");
          if ((representative.constituentEventCount ?? 1) <= 1) reasons.push("representative-not-consolidated");
          if (representative.stablecoinId !== previousEntry.stablecoinId) reasons.push("representative-coin-mismatch");
          if (representative.direction !== previousEntry.direction) reasons.push("representative-direction-mismatch");
        }
      }
      if (reasons.length > 0) {
        console.warn(`[sync-depeg-events] Archive lineage rejected: ${JSON.stringify({
          slug: previousEntry.slug,
          eventId: previousEntry.id,
          reasons,
          incidentKey: incident?.incidentKey ?? null,
          currentEventId: incident?.live.currentEventId ?? null,
          eventState: incident?.live.eventState ?? null,
          constituentEventCount: representative?.constituentEventCount ?? null,
        })}`);
        continue;
      }
    } else if (hasDedicatedDepegEventPage(currentEntry) && !hasReviewedDepegEvent(previousEntry)) {
      pagesBySlug.set(previousEntry.slug, currentEntry);
      continue;
    }
    pagesBySlug.set(previousEntry.slug, resolveRetainedDepegEventPage(previousEntry, currentEntry));
  }

  return [...pagesBySlug.values()].sort((a, b) => {
    if (b.startedAt !== a.startedAt) return b.startedAt - a.startedAt;
    return a.slug.localeCompare(b.slug);
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

function buildDepegEventIndex(entries: readonly DepegEventEntry[], ledger: readonly DepegEventEntry[]) {
  const fetched = new Set(ledger);
  return entries.map((event) => ({
    ...(fetched.has(event) ? {} : { retainedPage: event }),
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
  pages: readonly DepegEventEntry[],
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

  writeFileSync(paths.indexFile, `${JSON.stringify(buildDepegEventIndex(pages, entries), null, 2)}\n`);
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

async function isMissingLedgerManifest(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  const error: unknown = await response.clone().json().catch(() => null);
  return typeof error === "object" && error !== null && "reason" in error && error.reason === "ledger-manifest-unavailable";
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
  const previousBySlug = new Map(readDepegEventSnapshot({ missing: "empty" }, outputPaths.dataDir).map((row) => [row.slug, row]));
  const previousPagesBySlug = new Map(selectStaticDepegEventPages([...previousBySlug.values()]).map((row) => [row.slug, row]));
  for (const { slug, retainedPage } of readDepegEventIndex({ missing: "empty" }, outputPaths.indexFile)) {
    const current = previousBySlug.get(slug);
    const page = retainedPage ? resolveRetainedDepegEventPage(retainedPage, current) : current;
    if (page) {
      previousPagesBySlug.set(slug, page);
      previousBySlug.set(slug, page);
    }
  }
  const previousEntries = [...previousBySlug.values()];
  const previousPages = [...previousPagesBySlug.values()];
  const headers = new Headers(await apiFetchHeaders(["DEPEG_EVENTS_API_KEY", "SMOKE_API_KEY"], { url: apiUrl }));

  console.log(`[sync-depeg-events] Source: ${apiUrl}`);

  let publicationStarted = false;
  try {
    const observationStartedAtISO = new Date().toISOString();
    const { entries, pageEntries, apiTotal, ledgerProof } = await (async () => {
      const collected: DepegEvent[] = [];
      let ledgerProof: DepegLedgerCapture["ledgerProof"];
      let cursor: string | null = null;
      let expectedTotal: number | undefined;
      const isSiteApi = new URL(apiUrl).hostname === new URL(SITE_API_ORIGIN).hostname;
      const skipLedgerProbe = process.env.PHAROS_DEPEG_SKIP_LEDGER_PROBE?.trim() === "1";
      // Verified-ledger probes require DEPEG_LEDGER_PAGE_SIZE (1000); unpinned site-api
      // reads can use limit=5000 with HTTP 400 fallback for rolled-back Workers.
      let limit = skipLedgerProbe && isSiteApi ? SITE_API_DEPEG_SYNC_LIMIT : DEPEG_LEDGER_PAGE_SIZE;
      const maxPages = MAX_DEPEG_SYNC_PAGES; // safety ceiling, never a successful partial ledger
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        params.set("includeTotal", "true");
        if ((!skipLedgerProbe && page === 0) || ledgerProof) params.set("ledgerGeneration", ledgerProof?.generation ?? "latest");
        if (cursor) params.set("cursor", cursor);
        const fetchPage = () => fetchWithRetry(`${apiUrl}?${params}`, { headers }, {
          logLabel: "sync-depeg-events",
          retryStatuses: [403],
          backoffMs: [12_000, 12_000],
          terminalResponse: isMissingLedgerManifest,
        });
        let res = await fetchPage();
        let unpinned = skipLedgerProbe;
        if (page === 0 && !skipLedgerProbe && await isMissingLedgerManifest(res)) {
          await res.body?.cancel();
          params.delete("ledgerGeneration");
          unpinned = true;
          if (isSiteApi) {
            limit = SITE_API_DEPEG_SYNC_LIMIT;
            params.set("limit", String(limit));
          }
          res = await fetchPage();
        }
        if (page === 0 && unpinned && limit > DEPEG_LEDGER_PAGE_SIZE && res.status === 400) {
          await res.body?.cancel();
          console.warn(
            `[sync-depeg-events] API rejected limit=${limit} with HTTP 400; falling back to limit=${DEPEG_LEDGER_PAGE_SIZE}`,
          );
          limit = DEPEG_LEDGER_PAGE_SIZE;
          params.set("limit", String(limit));
          res = await fetchPage();
        }
        if (!res.ok) {
          const message = `API returned ${res.status} for ${apiUrl}?${params}`;
          if (ledgerProof) throw new SnapshotIntegrityError(message);
          throw new Error(message);
        }
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
        if (page === 0 && !unpinned) ledgerProof = body.ledgerProof;
        if (body.ledgerProof?.generation !== ledgerProof?.generation ||
          body.ledgerProof?.coveredFromSec !== ledgerProof?.coveredFromSec ||
          body.ledgerProof?.coveredThroughSec !== ledgerProof?.coveredThroughSec) {
          throw new SnapshotIntegrityError("Depeg ledger proof changed during traversal");
        }
        if (ledgerProof && (body.totalExact !== true || body.total === undefined ||
          body.nextCursor === undefined || body.events.length !== Math.min(limit, body.total - collected.length) ||
          Boolean(body.nextCursor) !== (collected.length + body.events.length < body.total))) {
          throw new SnapshotIntegrityError("Incomplete verified depeg ledger page");
        }
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

      const stored = DepegEventStoredSnapshotSchema.safeParse(assignSlugs(unique, previousEntries));
      if (!stored.success) throw new SnapshotIntegrityError(`Invalid stored depeg snapshot: ${stored.error.message}`);
      const computedEntries = stored.data;
      let lineage: DepegArchiveLineage = [];
      const missingPublishedEntries = previousPages.filter((entry) => !seen.has(entry.id));
      const hasConsolidatedRepresentative = unique.some((event) => (event.constituentEventCount ?? 1) > 1);
      if (missingPublishedEntries.length > 0 && !hasConsolidatedRepresentative) {
        console.warn("[sync-depeg-events] Incident lineage lookup skipped: no multi-constituent API rows");
      }
      if (hasConsolidatedRepresentative && missingPublishedEntries.length > 0) {
        // Keep the selected API lane (including /_site-data/) and authentication.
        const lineageUrl = new URL("./depeg-resolver", apiUrl).href;
        console.log(`[sync-depeg-events] Incident lineage source: ${lineageUrl}; missing published IDs: ${
          missingPublishedEntries.map((entry) => entry.id).join(", ")
        }`);
        const response = await fetchWithRetry(lineageUrl, { headers }, { logLabel: "sync-depeg-events" });
        if (!response.ok) throw new Error(`API returned ${response.status} for ${lineageUrl}`);
        let payload: unknown;
        try {
          payload = await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new SnapshotIntegrityError("Invalid depeg incident lineage: malformed JSON");
          }
          throw error;
        }
        const parsed = DepegArchiveLineageSchema.safeParse(payload);
        if (!parsed.success) {
          throw new SnapshotIntegrityError(`Invalid depeg incident lineage: ${parsed.error.message}`);
        }
        lineage = parsed.data.rows;
        console.log(`[sync-depeg-events] Incident lineage: ${lineage.length} resolver rows admitted`);
      }
      const archivePreservedEntries = preserveStaticDepegArchiveEntries(previousPages, computedEntries, lineage);

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
        previousPages,
        archivePreservedEntries,
        options.allowArchiveShrink,
      );
      return { entries: computedEntries, pageEntries: archivePreservedEntries, apiTotal: expectedTotal ?? null, ledgerProof };
    })();
    const shardCount = new Set(
      entries.map((entry) => String(new Date(entry.startedAt * 1000).getUTCFullYear())),
    ).size;
    if (!options.dryRun) {
      publicationStarted = true;
      writeDepegEventLedger(entries, pageEntries, outputPaths);
      const capture: DepegLedgerCapture = {
        schemaVersion: 1,
        shardSource: "fetched-ledger",
        captureId: depegLedgerCaptureId(outputPaths.dataDir),
        observationStartedAtISO,
        observedAtISO: new Date().toISOString(),
        sourceUrl: apiUrl,
        methodologyVersionLabel: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
        eventCount: entries.length,
        apiTotal,
        ledgerProof,
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
    // Integrity failures and partial publication must never be relabeled as fetch outages.
    if (publicationStarted || err instanceof SnapshotIntegrityError) throw err;
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
