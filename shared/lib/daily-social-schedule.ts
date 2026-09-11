const DAILY_SOCIAL_TIME_ZONE = "Europe/Belgrade";
const DAILY_SOCIAL_PREPARATION_LEAD_SEC = 3600;
export const DAILY_SOCIAL_MAX_SOURCE_AGE_SEC = 3 * 3600;
export const DAILY_SOCIAL_MAX_CAPTURE_AGE_SEC = 2 * 3600;

export const DAILY_SOCIAL_TOPICS = [
  "market-overview", "market-growth", "yield-watch", "liquidity-growth", "market-share", "stability", "safety",
] as const;
export type DailySocialTopic = typeof DAILY_SOCIAL_TOPICS[number];

function localParts(nowSec: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: DAILY_SOCIAL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowSec * 1000));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

/** Convert an unambiguous 14:00 local wall time with the runtime's IANA timezone data. */
export function dailySocialScheduledAt(editionDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate)) throw new Error("Invalid daily social edition date");
  const desired = Date.parse(`${editionDate}T14:00:00Z`) / 1000;
  if (!Number.isFinite(desired) || new Date(desired * 1000).toISOString().slice(0, 10) !== editionDate) {
    throw new Error("Invalid daily social edition date");
  }
  let scheduledAt = desired;
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = localParts(scheduledAt);
    const localWall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`) / 1000;
    scheduledAt += desired - localWall;
  }
  return scheduledAt;
}

export function getDailySocialEdition(nowSec: number): { editionDate: string; scheduledAt: number; topic: DailySocialTopic } {
  const p = localParts(nowSec);
  const editionDate = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(`${editionDate}T12:00:00Z`).getUTCDay();
  return { editionDate, scheduledAt: dailySocialScheduledAt(editionDate), topic: DAILY_SOCIAL_TOPICS[weekday] };
}

export function dailySocialPreparationWindow(nowSec: number): boolean {
  const { scheduledAt } = getDailySocialEdition(nowSec);
  return nowSec >= scheduledAt - DAILY_SOCIAL_PREPARATION_LEAD_SEC && nowSec < scheduledAt;
}
