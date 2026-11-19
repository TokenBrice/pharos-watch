import { z } from "zod";
import { getCache } from "../../lib/db-cache";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY, type DepegLifecycleFlag } from "../../lib/depeg-lifecycle";
import { tryParseJson } from "../../lib/json-parse";
import { logWorkerEventArgs } from "../../lib/structured-log";

export interface DigestLifecycleIncident {
  eventId: number;
  stablecoinId: string;
  startedAt: number;
}

export interface DigestLifecycleFlag extends DepegLifecycleFlag {
  eventId?: number;
  startedAt?: number;
  evaluatedAt: number;
  priceObservedAt?: number;
}

const clock = z.number().int().positive();
const queueSchema = z.object({
  updatedAt: clock,
  flags: z.array(z.object({
    stablecoinId: z.string().min(1),
    symbol: z.string().min(1),
    kind: z.enum(["stalled-collapse", "chronic-shallow"]),
    currentBps: z.number().finite(),
    ageDays: z.number().int().nonnegative(),
    mcapUsd: z.number().finite().nonnegative(),
    eventId: clock.optional(),
    startedAt: clock.optional(),
    evaluatedAt: clock.optional(),
    priceObservedAt: clock.optional(),
  })),
});

export function sortDigestLifecycleFlags(flags: DigestLifecycleFlag[]): DigestLifecycleFlag[] {
  return flags.sort((a, b) => Math.abs(b.currentBps) * b.mcapUsd - Math.abs(a.currentBps) * a.mcapUsd);
}

/** Null leaves the writer's whole-queue guard in place. */
export async function reconcilePartialDigestLifecycleQueue(
  db: D1Database,
  census: {
    activeDepegSignalKeys: string[] | null;
    lifecycleFlags: DigestLifecycleFlag[];
    lifecycleUnavailable: DigestLifecycleIncident[];
  },
  now: number,
): Promise<DigestLifecycleFlag[] | null> {
  const { activeDepegSignalKeys, lifecycleFlags, lifecycleUnavailable } = census;
  if (lifecycleUnavailable.length === 0 || activeDepegSignalKeys == null ||
      lifecycleUnavailable.length === activeDepegSignalKeys.length) return null;

  try {
    const row = await getCache(db, DEPEG_LIFECYCLE_FLAGS_CACHE_KEY);
    if (!row) return lifecycleFlags;
    const prior = queueSchema.safeParse(tryParseJson(row.value, { onFailure: () => undefined }));
    if (!prior.success || prior.data.updatedAt > now) return null;

    const carried = prior.data.flags.flatMap((flag): DigestLifecycleFlag[] => {
      const evaluatedAt = flag.evaluatedAt ?? prior.data.updatedAt;
      const incident = lifecycleUnavailable.find((item) => item.stablecoinId === flag.stablecoinId &&
        (flag.eventId !== undefined
          ? flag.eventId === item.eventId && flag.startedAt === item.startedAt
          : activeDepegSignalKeys.filter((key) => key.startsWith(`${flag.stablecoinId}:`)).length === 1));
      if (!incident || evaluatedAt < incident.startedAt || evaluatedAt > prior.data.updatedAt ||
          (flag.priceObservedAt != null && flag.priceObservedAt > evaluatedAt)) return [];
      return [{ ...flag, evaluatedAt, eventId: incident.eventId, startedAt: incident.startedAt }];
    });
    return sortDigestLifecycleFlags([...lifecycleFlags, ...carried]);
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[daily-digest] Failed to read the prior lifecycle review queue:", error);
    return null;
  }
}
