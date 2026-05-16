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
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface DepegEventsResponse {
  events: DepegEvent[];
  total?: number;
  nextCursor?: string | null;
}

interface DepegEventEntry extends DepegEvent {
  slug: string;
}

function tsToDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function symbolToSlugPart(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function baseSlug(event: DepegEvent): string {
  const sanitized = symbolToSlugPart(event.symbol);
  const symbolPart = sanitized.length > 0 ? sanitized : event.stablecoinId;
  return `${symbolPart}-${tsToDate(event.startedAt)}`;
}

function getArgValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function resolveApiUrl(): string {
  const explicit =
    getArgValue("--api-url") ??
    process.env.DEPEG_EVENTS_API_URL ??
    process.env.SMOKE_API_BASE ??
    process.env.API_BASE_URL;
  if (!explicit) {
    throw new Error(
      "Provide --api-url or set DEPEG_EVENTS_API_URL / SMOKE_API_BASE / API_BASE_URL before running sync-depeg-events.",
    );
  }
  if (explicit.endsWith("/api/depeg-events")) return explicit;
  return `${explicit.replace(/\/+$/, "")}/api/depeg-events`;
}

function resolveOutputPath(): URL {
  const explicit = getArgValue("--output");
  if (!explicit) return new URL("../../data/depeg-events.json", import.meta.url);
  return new URL(explicit, `file://${process.cwd()}/`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  attempts = 3,
  backoff = [1000, 2000],
): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (i < attempts - 1) {
        const delay = backoff[i] ?? backoff[backoff.length - 1];
        console.log(`[sync-depeg-events] Attempt ${i + 1}/${attempts} failed (${reason}); retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
    if (res.ok || res.status < 500) return res;
    if (i < attempts - 1) {
      const delay = backoff[i] ?? backoff[backoff.length - 1];
      console.log(
        `[sync-depeg-events] Attempt ${i + 1}/${attempts} failed (HTTP ${res.status}); retrying in ${delay}ms...`,
      );
      await sleep(delay);
    } else {
      return res;
    }
  }
  throw new Error("fetchWithRetry: exhausted attempts");
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

export function selectConfirmedEvents(events: readonly DepegEvent[]): DepegEvent[] {
  return [...events];
}

async function main() {
  const apiUrl = resolveApiUrl();
  const outputPath = resolveOutputPath();
  const apiKey = (process.env.DEPEG_EVENTS_API_KEY ?? process.env.SMOKE_API_KEY ?? "").trim();

  const headers = new Headers();
  if (apiKey) headers.set("X-API-Key", apiKey);

  console.log(`[sync-depeg-events] Source: ${apiUrl}`);
  const collected: DepegEvent[] = [];
  let cursor: string | null = null;
  const limit = 1000;
  const maxPages = 20; // hard ceiling so we cannot loop forever
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const pagedUrl = `${apiUrl}?${params.toString()}`;
    const res = await fetchWithRetry(pagedUrl, { headers });
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
  const confirmed = selectConfirmedEvents(collected);

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

  const entries = assignSlugs(unique);

  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const outputFile = fileURLToPath(outputPath);

  // Guard against API returning an empty list (e.g. token expiry, partial
  // outage, or a misconfigured API base). Wiping the seed event would purge
  // every /depeg/<slug>/ static page on the next build and invalidate the
  // depeg RSS feed for downstream subscribers. Treat empty + non-empty
  // existing file as a hard error rather than a silent overwrite.
  if (entries.length === 0 && existsSync(outputFile)) {
    let previous: unknown;
    try {
      previous = JSON.parse(readFileSync(outputFile, "utf8"));
    } catch {
      previous = null;
    }
    if (Array.isArray(previous) && previous.length > 0) {
      console.error(
        `[sync-depeg-events] API returned 0 events but ${outputFile} currently holds ${previous.length}. ` +
          `Refusing to overwrite — pass --allow-empty to override (e.g. when the API is intentionally drained).`,
      );
      if (!process.argv.includes("--allow-empty")) {
        process.exit(1);
      }
    }
  }

  mkdirSync(new URL(".", outputPath), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(entries, null, 2) + "\n");
  console.log(`[sync-depeg-events] Wrote ${entries.length} confirmed events to ${outputFile}`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
