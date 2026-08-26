import { readFileSync } from "node:fs";
import path from "node:path";
import { rssResponse, toRfc822, type RssItem } from "@/lib/rss";
import {
  getPeakDeviationMagnitudeBps,
  selectStaticDepegEventPages,
} from "@/lib/depeg-event-config";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import {
  DepegEventStoredSnapshotSchema,
  type DepegEventEntry,
} from "@shared/types/market";

export const dynamic = "force-static";
export const revalidate = false;

const FEED_PATH = "/feed/depeg.xml";
const MAX_ITEMS = 100;
/** W3-D will populate this file during prebuild. Until then, treat absence as zero events. */
const DEPEG_EVENTS_PATH = path.join(process.cwd(), "data/depeg-events.json");

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function parseEvents(raw: string): DepegEventEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Failed to parse ${DEPEG_EVENTS_PATH} as JSON.`, { cause });
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${DEPEG_EVENTS_PATH} to contain an array of depeg events.`);
  }

  const result = DepegEventStoredSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const issuePath = firstIssue?.path.length ? firstIssue.path.join(".") : "<root>";
    const issueMessage = firstIssue?.message ?? "schema validation failed";
    throw new Error(`Invalid depeg feed event data at ${issuePath}: ${issueMessage}`);
  }

  return result.data;
}

function loadEvents(): DepegEventEntry[] {
  let raw: string;
  try {
    raw = readFileSync(DEPEG_EVENTS_PATH, "utf-8");
  } catch (cause) {
    if (isEnoent(cause)) return [];
    throw cause;
  }
  return parseEvents(raw);
}

function depegItems(events: readonly DepegEventEntry[]): RssItem[] {
  const staticPageSlugs = new Set(selectStaticDepegEventPages(events).map((event) => event.slug));
  return events
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_ITEMS)
    .map((event) => {
      const startedISO = new Date(event.startedAt * 1000).toISOString().slice(0, 10);
      const sign = event.direction === "below" ? "-" : "+";
      const peakBps = getPeakDeviationMagnitudeBps(event);
      const title = `${event.symbol} depeg ${sign}${peakBps} bps`;
      const status = event.endedAt ? "Resolved" : "Active";
      const eventLink =
        staticPageSlugs.has(event.slug)
          ? `${SITE_URL}/depeg/${event.slug}/`
          : `${SITE_URL}${buildStablecoinUrl(event.stablecoinId, "#depeg-history")}`;
      return {
        title,
        link: eventLink,
        description: `${status} ${event.direction} peg by ${peakBps} bps starting ${startedISO}.`,
        guid: `pharos:depeg-event:${event.slug}`,
        pubDate: toRfc822(event.startedAt * 1000),
      };
    });
}

export async function GET(): Promise<Response> {
  const items = depegItems(loadEvents());
  return rssResponse({
    title: "Pharos Depeg Events",
    link: `${SITE_URL}/depeg/`,
    feedUrl: `${SITE_URL}${FEED_PATH}`,
    description:
      "Confirmed depeg events tracked by pharos.watch — symbol, direction, peak deviation, and resolution status.",
    language: "en-US",
    items,
  });
}
